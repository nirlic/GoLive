#!/usr/bin/env node
/**
 * GoLive v1.1.0 - GoPro Hero 13 Live Stream Server
 * ──────────────────────────────────────────────────
 * • Receives RTMP from GoPro (local Wi-Fi)
 * • Transcodes to HLS via FFmpeg
 * • Serves viewer to any device via Cloudflare Tunnel (internet)
 * • Password protection, multi-user, time-limited links
 * • Stream recording, viewer count, auto-restart
 * • Web-based setup UI at /setup
 * • System tray support via tray.ps1
 *
 * Requirements: Node.js 18+, FFmpeg in PATH or set in config.json
 * Usage:        node server.js
 *
 * Developed by Nirlicnick · v1.1.0
 */

'use strict';

const http      = require('http');
const net       = require('net');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const crypto    = require('crypto');
const { spawn } = require('child_process');

// ── Directories ───────────────────────────────────────────────────────────────
const ROOT_DIR       = __dirname;
const HLS_DIR        = path.join(ROOT_DIR, 'hls');
const RECORDINGS_DIR = path.join(ROOT_DIR, 'recordings');
const CONFIG_FILE    = path.join(ROOT_DIR, 'config.json');

// ── Default CONFIG (overridden by config.json) ────────────────────────────────
let CONFIG = {
  rtmpPort:        1935,
  httpPort:        8080,
  streamKey:       'golive',
  ffmpegPath:      'ffmpeg',
  cloudflaredPath: 'cloudflared',
  hlsTime:         2,
  hlsListSize:     5,
  record:          false,
  linkExpiryHours: 0,
};

// ── Auth ──────────────────────────────────────────────────────────────────────
let USERS = [];  // [{username, passHash}]

// ── Runtime state ─────────────────────────────────────────────────────────────
let ffmpegProc    = null;
let isStreaming   = false;
let streamStart   = null;
let bytesIn       = 0;
let tunnelUrl     = null;
let cfProc        = null;
let recordingFile = null;

const viewerHeartbeats = new Map();  // ip -> timestamp
const VIEWER_TIMEOUT   = 10000;

const activeTokens = new Map();  // token -> {expiresAt, username}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] [' + tag + '] ' + msg);
}

function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanHlsDir() {
  ensureDir(HLS_DIR);
  try {
    fs.readdirSync(HLS_DIR)
      .filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'))
      .forEach(f => { try { fs.unlinkSync(path.join(HLS_DIR, f)); } catch(_){} });
  } catch(_) {}
}

function hashPass(p) {
  return crypto.createHash('sha256').update(String(p)).digest('hex');
}

function activeViewerCount() {
  const cutoff = Date.now() - VIEWER_TIMEOUT;
  let n = 0;
  for (const [, ts] of viewerHeartbeats) if (ts > cutoff) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG LOADING
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.warn('[Config] WARNING: config.json not found - stream is unprotected.');
    return;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch(e) { console.error('[Config] Bad JSON: ' + e.message); process.exit(1); }

  const keys = ['rtmpPort','httpPort','streamKey','ffmpegPath','cloudflaredPath',
                 'hlsTime','hlsListSize','record','linkExpiryHours'];
  for (const k of keys) if (raw[k] !== undefined) CONFIG[k] = raw[k];

  USERS = [];
  if (Array.isArray(raw.users) && raw.users.length) {
    for (const u of raw.users) {
      if (u.username && u.password)
        USERS.push({ username: u.username.trim(), passHash: hashPass(u.password) });
    }
  } else if (raw.password) {
    USERS.push({ username: (raw.username || 'golive').trim(), passHash: hashPass(raw.password) });
  }

  if (USERS.length) {
    log('Auth', 'Password protection ENABLED (' + USERS.length + ' user' + (USERS.length > 1 ? 's' : '') + ')');
  } else {
    console.warn('[Config] WARNING: No password set - stream is unprotected.');
  }
  if (CONFIG.record)          log('Record', 'Recording ENABLED');
  if (CONFIG.linkExpiryHours) log('Auth',   'Link expiry: ' + CONFIG.linkExpiryHours + 'h');
}

loadConfig();

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

function generateToken(username) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = CONFIG.linkExpiryHours > 0
    ? Date.now() + CONFIG.linkExpiryHours * 3600000 : null;
  activeTokens.set(token, { username, expiresAt, createdAt: Date.now() });
  return token;
}

function validateToken(token) {
  const e = activeTokens.get(token);
  if (!e) return null;
  if (e.expiresAt && Date.now() > e.expiresAt) { activeTokens.delete(token); return null; }
  return e;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, e] of activeTokens)
    if (e.expiresAt && now > e.expiresAt) activeTokens.delete(t);
}, 600000);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

function checkBasicAuth(req) {
  if (!USERS.length) return { ok: true, username: 'anonymous' };
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return { ok: false };
  let dec;
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch(_) { return { ok: false }; }
  const i = dec.indexOf(':');
  if (i < 0) return { ok: false };
  const user = USERS.find(u => u.username === dec.slice(0, i) && u.passHash === hashPass(dec.slice(i + 1)));
  return user ? { ok: true, username: user.username } : { ok: false };
}

function checkTokenAuth(req) {
  const qs = (req.url || '').split('?')[1] || '';
  const token = new URLSearchParams(qs).get('token');
  return token ? validateToken(token) : null;
}

function requireAuth(req, res) {
  if (!USERS.length) return true;
  if (checkTokenAuth(req)) return true;
  const a = checkBasicAuth(req);
  if (a.ok) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="GoLive", charset="UTF-8"');
  res.writeHead(401); res.end('Unauthorized');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────────────────────────────────────────

function startFFmpeg(socket) {
  cleanHlsDir();
  ensureDir(HLS_DIR);

  const m3u8 = path.join(HLS_DIR, 'stream.m3u8');
  const seg  = path.join(HLS_DIR, 'seg%05d.ts');

  const args = [
    '-loglevel', 'warning', '-re', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-level', '3.1',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-g', '60', '-sc_threshold', '0', '-keyint_min', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
  ];

  if (CONFIG.record) {
    ensureDir(RECORDINGS_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    recordingFile = path.join(RECORDINGS_DIR, 'golive-' + ts + '.mp4');
    args.push('-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', recordingFile);
    log('Record', 'Saving to ' + recordingFile);
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(CONFIG.hlsTime),
    '-hls_list_size', String(CONFIG.hlsListSize),
    '-hls_flags', 'delete_segments+append_list+discont_start',
    '-hls_segment_filename', seg,
    m3u8
  );

  log('FFmpeg', 'Starting...');
  ffmpegProc = spawn(CONFIG.ffmpegPath, args, { stdio: ['pipe','pipe','pipe'], windowsHide: true });

  ffmpegProc.stderr.on('data', c => {
    const l = c.toString().trim();
    if (l) process.stdout.write('\r[FFmpeg] ' + l.slice(0, 110).padEnd(110));
  });

  ffmpegProc.on('close', code => {
    console.log('');
    log('FFmpeg', 'Exited (' + code + ')');
    ffmpegProc = null; isStreaming = false; streamStart = null; recordingFile = null;
  });

  ffmpegProc.on('error', err => {
    console.log('');
    if (err.code === 'ENOENT') log('ERROR', 'FFmpeg not found - set ffmpegPath in config.json');
    else log('ERROR', 'FFmpeg: ' + err.message);
    isStreaming = false;
  });

  socket.on('data', chunk => {
    bytesIn += chunk.length;
    if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed)
      ffmpegProc.stdin.write(chunk, ()=>{});
  });
  socket.on('end', () => {
    log('RTMP', 'GoPro disconnected');
    if (ffmpegProc && ffmpegProc.stdin) ffmpegProc.stdin.end();
    isStreaming = false;
  });
  socket.on('error', err => {
    log('RTMP', 'Socket: ' + err.message);
    if (ffmpegProc && ffmpegProc.stdin) ffmpegProc.stdin.end();
    isStreaming = false;
  });

  isStreaming = true;
  streamStart = Date.now();
  log('Stream', '*** LIVE - ' + activeViewerCount() + ' viewer(s) ***');
  if (tunnelUrl) log('Stream', 'Watch at: ' + tunnelUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// RTMP SERVER
// ─────────────────────────────────────────────────────────────────────────────

const rtmpServer = net.createServer(socket => {
  log('RTMP', 'Connection: ' + socket.remoteAddress);
  socket.setTimeout(15000);
  let buf = Buffer.alloc(0), done = false;

  socket.on('data', chunk => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 1537) return;
    if (buf[0] !== 3) { log('RTMP', 'Bad version'); socket.destroy(); return; }

    const s0 = Buffer.from([0x03]);
    const s1 = Buffer.alloc(1536, 0);
    s1.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    for (let i = 8; i < 1536; i++) s1[i] = Math.random() * 256 | 0;
    const s2 = buf.slice(1, 1537);

    socket.write(Buffer.concat([s0, s1, s2]), () => {
      done = true;
      log('RTMP', 'Handshake OK');
      const rem = buf.slice(1537);
      startFFmpeg(socket);
      if (rem.length && ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
        bytesIn += rem.length;
        ffmpegProc.stdin.write(rem);
      }
    });
  });

  socket.on('timeout', () => { if (!done) socket.destroy(); });
  socket.on('error', err => log('RTMP', err.message));
});

rtmpServer.listen(CONFIG.rtmpPort, '0.0.0.0', () => log('RTMP', 'Port ' + CONFIG.rtmpPort));
rtmpServer.on('error', err => {
  if (err.code === 'EACCES')
    log('ERROR', 'Port ' + CONFIG.rtmpPort + ' needs admin rights or change rtmpPort in config.json');
  else log('ERROR', 'RTMP: ' + err.message);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/MP2T',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

function json(res, code, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 500000) fail(new Error('Too large')); });
    req.on('end', () => ok(b));
    req.on('error', fail);
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store');
  const p = (req.url || '/').split('?')[0];

  // ── Status API ─────────────────────────────────────────────────────────────
  if (p === '/api/status') {
    viewerHeartbeats.set(req.socket.remoteAddress, Date.now());
    json(res, 200, {
      live:      isStreaming,
      uptime:    streamStart ? Math.floor((Date.now() - streamStart) / 1000) : 0,
      mbReceived:(bytesIn / 1048576).toFixed(1),
      viewers:   activeViewerCount(),
      recording: CONFIG.record && !!recordingFile,
    });
    return;
  }

  // ── Generate time-limited link ─────────────────────────────────────────────
  if (p === '/api/generate-link' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const a = checkBasicAuth(req);
    const token = generateToken(a.username || 'user');
    const base  = tunnelUrl || ('http://' + getLocalIPs()[0] + ':' + CONFIG.httpPort);
    json(res, 200, {
      link:      base + '/watch?token=' + token,
      expiresIn: CONFIG.linkExpiryHours > 0 ? CONFIG.linkExpiryHours + 'h' : 'never',
    });
    log('Auth', 'Time-limited link generated');
    return;
  }

  // ── Recordings list ────────────────────────────────────────────────────────
  if (p === '/api/recordings') {
    if (!requireAuth(req, res)) return;
    ensureDir(RECORDINGS_DIR);
    const files = fs.readdirSync(RECORDINGS_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const s = fs.statSync(path.join(RECORDINGS_DIR, f));
        return { name: f, size: (s.size / 1048576).toFixed(1) + ' MB', date: s.mtime };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    json(res, 200, { recordings: files });
    return;
  }

  // ── Get config (passwords redacted) ───────────────────────────────────────
  if (p === '/api/config' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(_) {}
    const safe = Object.assign({}, cfg);
    if (safe.password) safe.password = '••••••••';
    if (Array.isArray(safe.users))
      safe.users = safe.users.map(u => ({ username: u.username, password: '••••••••' }));
    json(res, 200, safe);
    return;
  }

  // ── Save config ────────────────────────────────────────────────────────────
  if (p === '/api/config' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch(_) { json(res, 400, { error: 'Invalid JSON' }); return; }
    let current = {};
    try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(_) {}

    // For users: if a user has no new password, keep the old one
    if (Array.isArray(body.users) && Array.isArray(current.users)) {
      body.users = body.users.map(nu => {
        if (!nu.password) {
          const old = current.users.find(o => o.username === nu.username);
          if (old) return { username: nu.username, password: old.password };
        }
        return nu;
      });
    }

    const merged = Object.assign(current, body);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    json(res, 200, { ok: true, message: 'Saved! Restart GoLive for most changes to take effect.' });
    log('Setup', 'Config updated via web UI');
    return;
  }

  // ── HLS segments (auth required) ──────────────────────────────────────────
  if (p.startsWith('/hls/')) {
    if (!requireAuth(req, res)) return;
    const file = path.join(HLS_DIR, path.basename(p));
    if (fs.existsSync(file)) {
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.writeHead(200);
      fs.createReadStream(file).pipe(res);
    } else { res.writeHead(404); res.end(); }
    return;
  }

  // ── Token-auth watch page ──────────────────────────────────────────────────
  if (p === '/watch') {
    if (!checkTokenAuth(req)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(403);
      res.end(expiredHTML());
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200); res.end(viewerHTML());
    return;
  }

  // ── Setup page ─────────────────────────────────────────────────────────────
  if (p === '/setup') {
    if (!requireAuth(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200); res.end(setupHTML());
    return;
  }

  // ── Main viewer ────────────────────────────────────────────────────────────
  if (p === '/' || p === '/index.html') {
    if (!requireAuth(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200); res.end(viewerHTML());
    return;
  }

  res.writeHead(404); res.end('Not found');
});

httpServer.listen(CONFIG.httpPort, '0.0.0.0', () => log('HTTP', 'Port ' + CONFIG.httpPort));

// ─────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE TUNNEL
// ─────────────────────────────────────────────────────────────────────────────

function startTunnel() {
  log('Tunnel', 'Starting Cloudflare Tunnel for GoLive...');
  cfProc = spawn(CONFIG.cloudflaredPath, [
    'tunnel', '--url', 'http://localhost:' + CONFIG.httpPort, '--no-autoupdate',
  ], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });

  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
  function onData(d) {
    const m = d.toString().match(re);
    if (m && !tunnelUrl) { tunnelUrl = m[0]; printBanner(); }
  }
  cfProc.stdout.on('data', onData);
  cfProc.stderr.on('data', onData);
  cfProc.on('error', err => {
    if (err.code === 'ENOENT')
      log('Tunnel', 'cloudflared not found - LOCAL access only. See README.');
    else log('Tunnel', 'Error: ' + err.message);
    printBanner();
  });
  cfProc.on('close', () => { tunnelUrl = null; });
  setTimeout(() => { if (!tunnelUrl) printBanner(); }, 15000);
}

// ─────────────────────────────────────────────────────────────────────────────
// BANNER
// ─────────────────────────────────────────────────────────────────────────────

function printBanner() {
  const ips = getLocalIPs();
  console.log('');
  console.log('  ========================================================');
  console.log('   GoLive v1.1.0  -  by Nirlicnick');
  console.log('  ========================================================');
  console.log('');
  console.log('  STEP 1 - Connect GoPro to same Wi-Fi as this PC');
  console.log('');
  console.log('  STEP 2 - Set GoPro RTMP URL to:');
  ips.forEach(ip => console.log('    rtmp://' + ip + ':' + CONFIG.rtmpPort + '/live/' + CONFIG.streamKey));
  console.log('');
  if (tunnelUrl) {
    console.log('  STEP 3 - Watch on any device (works ANYWHERE):');
    console.log('');
    console.log('  +------------------------------------------------------+');
    console.log('  |  ' + tunnelUrl.padEnd(52) + '|');
    console.log('  +------------------------------------------------------+');
    console.log('');
    console.log('  Setup & settings: ' + tunnelUrl + '/setup');
  } else {
    console.log('  STEP 3 - Watch on device (LOCAL network only):');
    ips.forEach(ip => console.log('    http://' + ip + ':' + CONFIG.httpPort));
    console.log('    Setup:  http://' + ips[0] + ':' + CONFIG.httpPort + '/setup');
    console.log('');
    console.log('  Waiting for Cloudflare tunnel...');
  }
  console.log('');
  console.log('  STEP 4 - Start streaming on your GoPro!');
  if (CONFIG.record) console.log('  ● Recording enabled - saved to recordings/');
  console.log('');
  console.log('  ========================================================');
  console.log('  Ctrl+C to stop  |  /setup for settings  |  tray: start-tray.bat');
  console.log('  ========================================================');
  console.log('');
}

startTunnel();

// ─────────────────────────────────────────────────────────────────────────────
// SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

function shutdown() {
  log('GoLive', 'Shutting down...');
  try { if (ffmpegProc) ffmpegProc.kill(); } catch(_) {}
  try { if (cfProc)     cfProc.kill();     } catch(_) {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
if (process.platform === 'win32') {
  require('readline').createInterface({ input: process.stdin }).on('SIGINT', shutdown);
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEWER HTML
// ─────────────────────────────────────────────────────────────────────────────

function viewerHTML() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>GoLive</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#080b10;--accent:#00e5ff;--red:#ff2d55;--text:#eceff4;--muted:#4a5568;--green:#00e676}
html,body{height:100%;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;
  overflow:hidden;-webkit-tap-highlight-color:transparent}
.app{display:flex;flex-direction:column;height:100dvh;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
header{position:absolute;top:0;left:0;right:0;z-index:20;display:flex;align-items:center;
  justify-content:space-between;padding:calc(env(safe-area-inset-top)+12px) 18px 12px;
  background:linear-gradient(to bottom,rgba(8,11,16,.95),transparent)}
.logo{display:flex;align-items:center;gap:9px}
.logo-mark{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),#0070f3);
  border-radius:8px;display:grid;place-items:center;font-size:17px}
.logo-text{font-size:14px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.hdr-right{display:flex;align-items:center;gap:8px}
.viewer-pill{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:4px}
.viewer-dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
.badge{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:999px;
  font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;transition:all .3s}
.badge.live{background:rgba(255,45,85,.15);border:1.5px solid rgba(255,45,85,.5);color:var(--red)}
.badge.offline{background:rgba(74,85,104,.12);border:1.5px solid rgba(74,85,104,.3);color:var(--muted)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.live .dot{animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.stage{flex:1;position:relative;background:#000;display:flex;align-items:center;justify-content:center}
video{width:100%;height:100%;object-fit:contain}
.wait{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:28px;background:var(--bg);transition:opacity .4s,visibility .4s}
.wait.gone{opacity:0;visibility:hidden}
.spinner{position:relative;width:72px;height:72px}
.ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid transparent}
.ring:nth-child(1){border-top-color:var(--accent);animation:spin 2s linear infinite}
.ring:nth-child(2){inset:10px;border-right-color:var(--red);animation:spin 1.4s linear infinite reverse}
.ring:nth-child(3){inset:20px;border-bottom-color:var(--accent);animation:spin .9s linear infinite}
.ring-icon{position:absolute;inset:0;display:grid;place-items:center;font-size:26px}
@keyframes spin{to{transform:rotate(360deg)}}
.wait-label{text-align:center}
.wait-label h2{font-size:19px;font-weight:700;margin-bottom:5px}
.wait-label p{font-size:13px;color:var(--muted);line-height:1.6;max-width:220px}
.overlay{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;
  background:linear-gradient(to top,rgba(8,11,16,.85) 0%,transparent 45%);
  padding:16px 20px;opacity:0;transition:opacity .25s;pointer-events:none}
.overlay.show{opacity:1;pointer-events:auto}
.overlay-row{display:flex;align-items:flex-end;justify-content:space-between}
.stats-col{display:flex;flex-direction:column;gap:5px}
.stat{font-size:11px;color:rgba(236,239,244,.6);font-variant-numeric:tabular-nums}
.stat span{color:var(--accent);font-weight:600}
.btns{display:flex;gap:10px}
.cb{width:44px;height:44px;border-radius:50%;border:none;
  background:rgba(255,255,255,.14);backdrop-filter:blur(12px);
  color:#fff;font-size:18px;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;
  transition:background .15s,transform .1s}
.cb:active{transform:scale(.9);background:rgba(255,255,255,.25)}
.cb-lbl{font-size:8px;color:rgba(255,255,255,.5);letter-spacing:.04em}
.reconnect{position:absolute;top:70px;left:50%;transform:translateX(-50%);
  background:rgba(255,45,85,.9);color:#fff;padding:8px 18px;border-radius:20px;
  font-size:12px;font-weight:700;opacity:0;transition:opacity .3s;white-space:nowrap;pointer-events:none}
.reconnect.show{opacity:1}
footer{display:flex;justify-content:space-around;
  padding:10px 0 calc(env(safe-area-inset-bottom)+8px);
  background:linear-gradient(to top,rgba(8,11,16,.96),transparent)}
.metric{text-align:center}
.metric-val{display:block;font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.metric-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(10px);
  background:rgba(22,27,34,.96);backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,.1);color:#fff;padding:10px 20px;
  border-radius:20px;font-size:13px;font-weight:600;opacity:0;
  transition:all .25s;white-space:nowrap;z-index:100;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="app">
  <div class="stage" id="stage">
    <div class="wait" id="wait">
      <div class="spinner">
        <div class="ring"></div><div class="ring"></div><div class="ring"></div>
        <div class="ring-icon">&#x1F4F9;</div>
      </div>
      <div class="wait-label">
        <h2>Waiting for GoPro</h2>
        <p>Start streaming on your GoPro to begin the live feed on this device.</p>
      </div>
    </div>

    <video id="vid" playsinline webkit-playsinline muted autoplay preload="none"></video>

    <div class="overlay" id="overlay">
      <div class="overlay-row">
        <div class="stats-col">
          <div class="stat">Uptime <span id="sUp">--:--:--</span></div>
          <div class="stat">Received <span id="sData">0 MB</span></div>
          <div class="stat">Latency <span id="sLat">~</span></div>
          <div class="stat" id="sRec" style="display:none">Recording <span style="color:var(--red)">&#x25CF; REC</span></div>
        </div>
        <div class="btns">
          <button class="cb" id="muteBtn"><span>&#x1F507;</span><span class="cb-lbl">SOUND</span></button>
          <button class="cb" id="pipBtn"><span>&#x29C9;</span><span class="cb-lbl">PIP</span></button>
          <button class="cb" id="snapBtn"><span>&#x1F4F8;</span><span class="cb-lbl">SNAP</span></button>
          <button class="cb" id="fsBtn"><span>&#x26F6;</span><span class="cb-lbl">FULL</span></button>
        </div>
      </div>
    </div>
    <div class="reconnect" id="recon">Reconnecting&#x2026;</div>
  </div>

  <header>
    <div class="logo">
      <div class="logo-mark">&#x1F3A5;</div>
      <span class="logo-text">GoLive</span>
    </div>
    <div class="hdr-right">
      <div class="viewer-pill" id="vPill" style="display:none">
        <div class="viewer-dot"></div><span id="vNum">1</span>
      </div>
      <div class="badge offline" id="badge">
        <div class="dot"></div><span id="bTxt">Offline</span>
      </div>
    </div>
  </header>

  <footer>
    <div class="metric"><span class="metric-val" id="mRes">--</span><span class="metric-lbl">Resolution</span></div>
    <div class="metric"><span class="metric-val" id="mFPS">--</span><span class="metric-lbl">Frame Rate</span></div>
    <div class="metric"><span class="metric-val" id="mView">--</span><span class="metric-lbl">Viewers</span></div>
  </footer>
</div>
<div class="toast" id="toast"></div>

<script>
(function(){
"use strict";
var HLS="/hls/stream.m3u8",POLL=3000;
var hls=null,live=false,muted=true,ct=null,toastT=null;
var vid=document.getElementById("vid"),
    wait=document.getElementById("wait"),
    badge=document.getElementById("badge"),
    bTxt=document.getElementById("bTxt"),
    overlay=document.getElementById("overlay"),
    recon=document.getElementById("recon"),
    sUp=document.getElementById("sUp"),
    sData=document.getElementById("sData"),
    sLat=document.getElementById("sLat"),
    sRec=document.getElementById("sRec"),
    mRes=document.getElementById("mRes"),
    mFPS=document.getElementById("mFPS"),
    mView=document.getElementById("mView"),
    vPill=document.getElementById("vPill"),
    vNum=document.getElementById("vNum"),
    toast=document.getElementById("toast");

function showToast(m,d){
  clearTimeout(toastT);
  toast.textContent=m; toast.classList.add("show");
  toastT=setTimeout(function(){toast.classList.remove("show");},d||2500);
}
function fmt(s){
  return String(Math.floor(s/3600)).padStart(2,"0")+":"+
    String(Math.floor((s%3600)/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
}
function loadHls(cb){
  if(window.Hls)return cb();
  var s=document.createElement("script");
  s.src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
  s.onload=s.onerror=cb;
  document.head.appendChild(s);
}
function startPlay(){
  if(live)return; live=true;
  wait.classList.add("gone");
  badge.className="badge live"; bTxt.textContent="Live";
  recon.classList.remove("show");
  loadHls(function(){
    if(window.Hls&&Hls.isSupported()){
      hls=new Hls({lowLatencyMode:true,backBufferLength:4,maxBufferLength:8,
        liveSyncDurationCount:2,liveMaxLatencyDurationCount:5});
      hls.loadSource(HLS); hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED,function(){vid.play();});
      hls.on(Hls.Events.FRAG_LOADED,function(e,d){
        sLat.textContent=Math.round(d.frag.stats.loading.end-d.frag.stats.loading.start)+"ms";
      });
      hls.on(Hls.Events.ERROR,function(e,d){
        if(d.fatal){stopPlay();recon.classList.add("show");}
      });
    } else if(vid.canPlayType("application/vnd.apple.mpegurl")){
      vid.src=HLS; vid.play();
    }
  });
  vid.addEventListener("loadedmetadata",function(){
    mRes.textContent=vid.videoWidth+"x"+vid.videoHeight;
  });
}
function stopPlay(){
  if(!live)return; live=false;
  if(hls){hls.destroy();hls=null;} vid.src="";
  wait.classList.remove("gone");
  badge.className="badge offline"; bTxt.textContent="Offline";
  mRes.textContent="--"; mFPS.textContent="--"; mView.textContent="--";
  sRec.style.display="none";
}
function poll(){
  fetch("/api/status").then(function(r){return r.json();}).then(function(d){
    if(d.live&&!live)startPlay();
    if(!d.live&&live)stopPlay();
    if(d.live){
      sUp.textContent=fmt(d.uptime);
      sData.textContent=d.mbReceived+" MB";
      var v=d.viewers||1;
      mView.textContent=v; vNum.textContent=v;
      vPill.style.display=v>1?"flex":"none";
      sRec.style.display=d.recording?"block":"none";
    }
  }).catch(function(){});
}

/* FPS */
var ff=0,fl=0;
function fps(now){
  ff++;
  if(now-fl>=1000){if(live)mFPS.textContent=ff+"fps";ff=0;fl=now;}
  if(live&&vid.requestVideoFrameCallback)vid.requestVideoFrameCallback(fps);
}
vid.addEventListener("play",function(){
  if(vid.requestVideoFrameCallback)vid.requestVideoFrameCallback(fps);
});

/* Controls */
document.getElementById("muteBtn").addEventListener("click",function(){
  muted=!muted; vid.muted=muted;
  this.querySelector("span").textContent=muted?"&#x1F507;":"&#x1F50A;";
  showToast(muted?"Muted":"Sound on",1500);
});
document.getElementById("pipBtn").addEventListener("click",function(){
  if(!document.pictureInPictureEnabled){showToast("PiP not supported");return;}
  if(document.pictureInPictureElement)document.exitPictureInPicture();
  else vid.requestPictureInPicture().catch(function(e){showToast("PiP: "+e.message);});
});
document.getElementById("snapBtn").addEventListener("click",function(){
  if(!live||vid.readyState<2){showToast("No video yet");return;}
  var c=document.createElement("canvas");
  c.width=vid.videoWidth; c.height=vid.videoHeight;
  c.getContext("2d").drawImage(vid,0,0);
  c.toBlob(function(b){
    var u=URL.createObjectURL(b),a=document.createElement("a");
    a.href=u; a.download="golive-"+new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")+".jpg";
    a.click(); setTimeout(function(){URL.revokeObjectURL(u);},5000);
    showToast("Snapshot saved!");
  },"image/jpeg",0.92);
});
document.getElementById("fsBtn").addEventListener("click",function(){
  var el=document.documentElement,
      req=el.requestFullscreen||el.webkitRequestFullscreen,
      ex=document.exitFullscreen||document.webkitExitFullscreen;
  if(document.fullscreenElement||document.webkitFullscreenElement)ex.call(document);
  else if(req)req.call(el);
});
document.getElementById("stage").addEventListener("click",function(){
  overlay.classList.add("show"); clearTimeout(ct);
  ct=setTimeout(function(){overlay.classList.remove("show");},4000);
});

poll(); setInterval(poll,POLL);
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP PAGE HTML
// ─────────────────────────────────────────────────────────────────────────────

function setupHTML() {
  const ips = getLocalIPs();
  const qrUrl = tunnelUrl || ('http://' + ips[0] + ':' + CONFIG.httpPort);
  const qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(qrUrl);

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GoLive Setup</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#00e5ff;
  --red:#ff2d55;--green:#00e676;--text:#e6edf3;--muted:#8b949e;--ibg:#0d1117}
body{background:var(--bg);color:var(--text);min-height:100vh;padding:24px 16px 60px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.page{max-width:680px;margin:0 auto}
.page-header{display:flex;align-items:center;justify-content:space-between;
  margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.title-wrap{display:flex;align-items:center;gap:12px}
.pg-logo{width:40px;height:40px;background:linear-gradient(135deg,var(--accent),#0070f3);
  border-radius:10px;display:grid;place-items:center;font-size:20px}
h1{font-size:20px;font-weight:700}
.ver{font-size:12px;color:var(--muted);margin-top:2px}
.btn-watch{padding:8px 16px;background:var(--accent);color:#000;border:none;
  border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
.status-bar{display:flex;gap:20px;flex-wrap:wrap;padding:14px 18px;
  background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:20px}
.si{display:flex;align-items:center;gap:8px;font-size:13px}
.sd{width:8px;height:8px;border-radius:50%}
.sd.live{background:var(--red);animation:pulse 1.5s infinite}
.sd.ok{background:var(--green)}
.sd.off{background:var(--muted)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sl{color:var(--muted)} .sv{font-weight:600}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px}
.ct{font-size:14px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.fr{margin-bottom:14px}
.fr label{display:block;font-size:11px;font-weight:600;color:var(--muted);
  margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
.fr input,.fr select{width:100%;padding:9px 12px;background:var(--ibg);
  border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;outline:none;transition:border .2s}
.fr input:focus{border-color:var(--accent)}
.fr .hint{font-size:11px;color:var(--muted);margin-top:4px}
.fr2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ul{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.ur{display:flex;align-items:center;gap:8px}
.ur input{flex:1;padding:8px 10px;background:var(--ibg);border:1px solid var(--border);
  border-radius:6px;color:var(--text);font-size:13px;outline:none}
.ur input:focus{border-color:var(--accent)}
.btn-rm{width:32px;height:32px;border:1px solid rgba(255,45,85,.3);
  background:rgba(255,45,85,.1);color:var(--red);border-radius:6px;
  cursor:pointer;font-size:16px;display:grid;place-items:center;flex-shrink:0}
.btn-add{padding:7px 14px;background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.3);
  color:var(--accent);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer}
.btn-save{width:100%;padding:12px;background:var(--accent);color:#000;border:none;
  border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px;transition:opacity .2s}
.btn-save:hover{opacity:.9} .btn-save:disabled{opacity:.5;cursor:not-allowed}
.save-msg{text-align:center;font-size:13px;margin-top:10px;min-height:20px;color:var(--green)}
.save-msg.err{color:var(--red)}
.qr-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0 12px}
.qr-wrap img{width:168px;height:168px;border-radius:8px;background:#fff;padding:8px}
.qr-url{font-size:12px;color:var(--muted);word-break:break-all;text-align:center}
.link-row{display:flex;gap:8px;margin-top:10px}
.link-row input{flex:1;padding:9px 12px;background:var(--ibg);border:1px solid var(--border);
  border-radius:8px;color:var(--muted);font-size:12px;font-family:monospace}
.btn-sm{padding:9px 14px;background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.3);
  color:var(--accent);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.btn-gen{padding:9px 16px;background:rgba(0,229,255,.12);border:1px solid rgba(0,229,255,.35);
  color:var(--accent);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.rec-item{display:flex;align-items:center;justify-content:space-between;
  padding:10px 14px;background:var(--ibg);border:1px solid var(--border);
  border-radius:8px;font-size:13px;margin-bottom:6px}
.rec-name{font-family:monospace;font-size:12px}
.rec-size{color:var(--muted);font-size:11px}
.no-rec{color:var(--muted);font-size:13px;padding:4px 0}
.chk-row{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px}
.chk-row input{width:17px;height:17px;cursor:pointer;accent-color:var(--accent)}
.pf{text-align:center;margin-top:28px;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<div class="page">
  <div class="page-header">
    <div class="title-wrap">
      <div class="pg-logo">&#x1F3A5;</div>
      <div><h1>GoLive Setup</h1><div class="ver">v1.1.0 &mdash; by Nirlicnick</div></div>
    </div>
    <a href="/" class="btn-watch">&#x25B6; Watch</a>
  </div>

  <div class="status-bar">
    <div class="si"><div class="sd off" id="sDot"></div><span class="sl">Stream:</span><span class="sv" id="sStat">Checking&hellip;</span></div>
    <div class="si"><div class="sd ok"></div><span class="sl">Viewers:</span><span class="sv" id="sView">0</span></div>
    <div class="si"><div class="sd ok"></div><span class="sl">Uptime:</span><span class="sv" id="sUp">--</span></div>
  </div>

  <!-- QR / Link -->
  <div class="card">
    <div class="ct">&#x1F4F1; Watch Link &amp; QR Code</div>
    <div class="qr-wrap">
      <img src="${qrSrc}" alt="QR Code" id="qrImg">
      <div class="qr-url" id="qrUrl">${qrUrl}</div>
    </div>
    <div class="fr">
      <label>Generate Time-Limited Shareable Link</label>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn-gen" id="genBtn">Generate Link</button>
        <span style="font-size:12px;color:var(--muted)">${CONFIG.linkExpiryHours > 0 ? 'Expires in ' + CONFIG.linkExpiryHours + 'h' : 'No expiry'}</span>
      </div>
      <div class="link-row" id="linkRow" style="display:none">
        <input type="text" id="linkVal" readonly>
        <button class="btn-sm" id="copyBtn">Copy</button>
      </div>
    </div>
  </div>

  <!-- Users -->
  <div class="card">
    <div class="ct">&#x1F512; Users &amp; Passwords</div>
    <div class="ul" id="userList"></div>
    <button class="btn-add" id="addBtn">+ Add User</button>
    <div class="hint" style="margin-top:8px;font-size:11px;color:var(--muted)">
      Leave password blank to keep existing password.
    </div>
  </div>

  <!-- Stream settings -->
  <div class="card">
    <div class="ct">&#x2699;&#xFE0F; Stream Settings</div>
    <div class="fr2">
      <div class="fr"><label>RTMP Port</label><input type="number" id="rtmpPort" value="${CONFIG.rtmpPort}"></div>
      <div class="fr"><label>Stream Key</label><input type="text" id="streamKey" value="${CONFIG.streamKey}"></div>
    </div>
    <div class="fr2">
      <div class="fr">
        <label>HLS Segment (s)</label>
        <input type="number" id="hlsTime" value="${CONFIG.hlsTime}" min="1" max="10">
        <div class="hint">Lower = less latency</div>
      </div>
      <div class="fr">
        <label>Playlist Size</label>
        <input type="number" id="hlsListSize" value="${CONFIG.hlsListSize}" min="2" max="20">
      </div>
    </div>
    <div class="fr">
      <label>FFmpeg Path</label>
      <input type="text" id="ffmpegPath" value="${CONFIG.ffmpegPath}">
      <div class="hint">Leave as 'ffmpeg' if in PATH. Otherwise full path e.g. C:\\ffmpeg\\bin\\ffmpeg.exe</div>
    </div>
    <div class="fr">
      <label class="chk-row">
        <input type="checkbox" id="record" ${CONFIG.record ? 'checked' : ''}>
        Enable Stream Recording (saves MP4 to recordings/)
      </label>
    </div>
    <div class="fr">
      <label>Link Expiry Hours (0 = never)</label>
      <input type="number" id="expiry" value="${CONFIG.linkExpiryHours}" min="0">
    </div>
    <button class="btn-save" id="saveBtn">Save Settings</button>
    <div class="save-msg" id="saveMsg"></div>
  </div>

  <!-- Recordings -->
  <div class="card">
    <div class="ct">&#x1F4BE; Recordings</div>
    <div id="recList"><div class="no-rec">Loading&hellip;</div></div>
  </div>

  <div class="pf">GoLive v1.1.0 &mdash; Developed by <strong>Nirlicnick</strong><br>
    <span style="color:#444">Most settings require a server restart to take effect.</span>
  </div>
</div>

<script>
(function(){
"use strict";
function fmt(s){
  return String(Math.floor(s/3600)).padStart(2,"0")+":"+
    String(Math.floor((s%3600)/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

// Status
function pollStatus(){
  fetch("/api/status").then(function(r){return r.json();}).then(function(d){
    var dot=document.getElementById("sDot"),stat=document.getElementById("sStat");
    stat.textContent=d.live?"LIVE":"Waiting for GoPro";
    dot.className="sd "+(d.live?"live":"off");
    document.getElementById("sView").textContent=d.viewers||0;
    document.getElementById("sUp").textContent=d.live?fmt(d.uptime):"--";
  }).catch(function(){});
}
pollStatus(); setInterval(pollStatus,3000);

// Recordings
function loadRecs(){
  fetch("/api/recordings").then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById("recList");
    if(!d.recordings||!d.recordings.length){
      el.innerHTML='<div class="no-rec">No recordings yet. Enable recording below.</div>';return;
    }
    el.innerHTML=d.recordings.map(function(r){
      return '<div class="rec-item"><span class="rec-name">'+esc(r.name)+'</span><span class="rec-size">'+esc(r.size)+'</span></div>';
    }).join("");
  }).catch(function(){});
}
loadRecs();

// Users
var users=[];
function renderUsers(){
  var el=document.getElementById("userList");
  el.innerHTML="";
  users.forEach(function(u,i){
    var row=document.createElement("div");
    row.className="ur";
    row.innerHTML='<input type="text" placeholder="Username" value="'+esc(u.username||"")+'" data-i="'+i+'" data-f="username">'+
      '<input type="password" placeholder="Password (blank = keep)" data-i="'+i+'" data-f="password">'+
      '<button class="btn-rm" data-i="'+i+'">&times;</button>';
    el.appendChild(row);
  });
  el.querySelectorAll("input").forEach(function(inp){
    inp.addEventListener("input",function(){users[+this.dataset.i][this.dataset.f]=this.value;});
  });
  el.querySelectorAll(".btn-rm").forEach(function(b){
    b.addEventListener("click",function(){users.splice(+this.dataset.i,1);renderUsers();});
  });
}
fetch("/api/config").then(function(r){return r.json();}).then(function(cfg){
  if(Array.isArray(cfg.users)&&cfg.users.length){
    users=cfg.users.map(function(u){return{username:u.username||"",password:""};});
  } else {
    users=[{username:cfg.username||"golive",password:""}];
  }
  renderUsers();
}).catch(function(){users=[{username:"golive",password:""}];renderUsers();});

document.getElementById("addBtn").addEventListener("click",function(){
  users.push({username:"",password:""});renderUsers();
});

// Save
document.getElementById("saveBtn").addEventListener("click",function(){
  var btn=this,msg=document.getElementById("saveMsg");
  btn.disabled=true; msg.textContent="Saving..."; msg.className="save-msg";
  var usersPayload=users.filter(function(u){return u.username.trim();}).map(function(u){
    var o={username:u.username.trim()};
    if(u.password)o.password=u.password;
    return o;
  });
  var payload={
    users:usersPayload,
    rtmpPort:+document.getElementById("rtmpPort").value||1935,
    streamKey:document.getElementById("streamKey").value||"golive",
    hlsTime:+document.getElementById("hlsTime").value||2,
    hlsListSize:+document.getElementById("hlsListSize").value||5,
    ffmpegPath:document.getElementById("ffmpegPath").value||"ffmpeg",
    record:document.getElementById("record").checked,
    linkExpiryHours:+document.getElementById("expiry").value||0,
  };
  fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){return r.json();})
    .then(function(d){msg.textContent=d.message||"Saved!";msg.className="save-msg";btn.disabled=false;})
    .catch(function(e){msg.textContent="Error: "+e.message;msg.className="save-msg err";btn.disabled=false;});
});

// Generate link
document.getElementById("genBtn").addEventListener("click",function(){
  fetch("/api/generate-link",{method:"POST"}).then(function(r){return r.json();}).then(function(d){
    document.getElementById("linkVal").value=d.link;
    document.getElementById("linkRow").style.display="flex";
  }).catch(function(){alert("Could not generate link.");});
});
document.getElementById("copyBtn").addEventListener("click",function(){
  navigator.clipboard.writeText(document.getElementById("linkVal").value).then(function(){
    document.getElementById("copyBtn").textContent="Copied!";
    setTimeout(function(){document.getElementById("copyBtn").textContent="Copy";},2000);
  });
});
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRED LINK PAGE
// ─────────────────────────────────────────────────────────────────────────────

function expiredHTML() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoLive &mdash; Link Expired</title>
<style>
body{background:#080b10;color:#eceff4;font-family:-apple-system,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px 24px}
.icon{font-size:56px;margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:8px}
p{color:#4a5568;font-size:15px}
</style>
</head>
<body>
<div class="box">
  <div class="icon">&#x23F0;</div>
  <h1>This link has expired</h1>
  <p>Ask the stream host to generate a new link.</p>
</div>
</body>
</html>`;
}
