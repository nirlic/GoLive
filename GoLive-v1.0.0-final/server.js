#!/usr/bin/env node
/**
 * GoLive v1.0.0 — GoPro Hero 13 Live Stream Server
 * ────────────────────────────────────────────────────
 * • Receives RTMP from GoPro (local Wi-Fi)
 * • Transcodes to HLS via FFmpeg
 * • Serves viewer page to any device via Cloudflare Tunnel (internet)
 *
 * Requirements: Node.js 18+, FFmpeg in PATH or configured below
 * Usage:        node server.js
 *
 * Developed by Nirlicnick
 */

'use strict';

const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  rtmpPort:    1935,
  httpPort:    8080,
  streamKey:   'gopro',

  // FFmpeg: 'ffmpeg' if it's in PATH, otherwise full Windows path e.g.:
  // 'C:\\ffmpeg\\bin\\ffmpeg.exe'
  ffmpegPath:  'ffmpeg',

  // HLS tuning
  hlsTime:     2,       // seconds per segment — lower = less latency
  hlsListSize: 5,       // segments kept in playlist

  // Cloudflare tunnel binary name (cloudflared must be in PATH or same folder)
  cloudflaredPath: 'cloudflared',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const HLS_DIR = path.join(__dirname, 'hls');

function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] [${tag}] ${msg}`);
}

function ensureHlsDir() {
  if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
}

function cleanHlsDir() {
  ensureHlsDir();
  try {
    fs.readdirSync(HLS_DIR)
      .filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'))
      .forEach(f => fs.unlinkSync(path.join(HLS_DIR, f)));
  } catch (_) {}
}

// ── State ─────────────────────────────────────────────────────────────────────
let ffmpegProc   = null;
let isStreaming  = false;
let streamStart  = null;
let bytesIn      = 0;
let tunnelUrl    = null;   // Set when Cloudflare tunnel starts

// ── FFmpeg HLS Transcoder ─────────────────────────────────────────────────────
function startFFmpeg(socket) {
  cleanHlsDir();

  const m3u8 = path.join(HLS_DIR, 'stream.m3u8');
  const segPattern = path.join(HLS_DIR, 'seg%05d.ts');

  const args = [
    '-loglevel', 'warning',
    '-re',
    '-i', 'pipe:0',

    // Video — H.264 baseline for maximum device compatibility
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-g', '60',
    '-sc_threshold', '0',
    '-keyint_min', '60',

    // Audio — AAC stereo
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',

    // HLS muxer
    '-f', 'hls',
    '-hls_time',     String(CONFIG.hlsTime),
    '-hls_list_size', String(CONFIG.hlsListSize),
    '-hls_flags', 'delete_segments+append_list+discont_start',
    '-hls_segment_filename', segPattern,
    m3u8,
  ];

  log('FFmpeg', 'Starting transcoder...');

  ffmpegProc = spawn(CONFIG.ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,  // Don't flash a console window on Windows
  });

  // Log FFmpeg stderr (progress + errors)
  ffmpegProc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line) process.stdout.write('\r[FFmpeg] ' + line.slice(0, 120).padEnd(120) + '  ');
  });

  ffmpegProc.on('close', code => {
    console.log('');
    log('FFmpeg', 'Exited (code ' + code + ')');
    ffmpegProc  = null;
    isStreaming = false;
    streamStart = null;
  });

  ffmpegProc.on('error', err => {
    console.log('');
    if (err.code === 'ENOENT') {
      log('ERROR', '*** FFmpeg not found! ***');
      log('ERROR', 'Set CONFIG.ffmpegPath in server.js to the full path, e.g.:');
      log('ERROR', '  C:\\\\ffmpeg\\\\bin\\\\ffmpeg.exe');
    } else {
      log('ERROR', 'FFmpeg error: ' + err.message);
    }
    isStreaming = false;
  });

  // Pipe socket → FFmpeg stdin
  socket.on('data', chunk => {
    bytesIn += chunk.length;
    if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
      ffmpegProc.stdin.write(chunk, () => {});
    }
  });

  socket.on('end', () => {
    log('RTMP', 'GoPro disconnected');
    if (ffmpegProc && ffmpegProc.stdin) ffmpegProc.stdin.end();
    isStreaming = false;
  });

  socket.on('error', err => {
    log('RTMP', 'Socket error: ' + err.message);
    if (ffmpegProc && ffmpegProc.stdin) ffmpegProc.stdin.end();
    isStreaming = false;
  });

  isStreaming = true;
  streamStart = Date.now();
  log('Stream', '*** GoPro stream is LIVE ***');
  if (tunnelUrl) log('Stream', 'GoLive stream at: ' + tunnelUrl);
}

// ── Minimal RTMP Handshake Server ─────────────────────────────────────────────
// We only do the C0/S0+S1+S2 handshake then hand the raw TCP socket to FFmpeg.
// FFmpeg fully understands RTMP and handles all the chunking/AMF/etc. itself.
const rtmpServer = net.createServer(socket => {
  log('RTMP', 'Connection from ' + socket.remoteAddress);
  socket.setTimeout(15000);

  let buf = Buffer.alloc(0);
  let handshakeDone = false;

  socket.on('data', chunk => {
    if (handshakeDone) return; // FFmpeg handles everything after handshake

    buf = Buffer.concat([buf, chunk]);

    // Need C0 (1 byte) + C1 (1536 bytes) = 1537 bytes minimum
    if (buf.length < 1537) return;

    const version = buf[0];
    if (version !== 3) {
      log('RTMP', 'Unexpected RTMP version: ' + version + ', closing');
      socket.destroy();
      return;
    }

    // Build S0 + S1 + S2
    const s0 = Buffer.from([0x03]);
    const s1 = Buffer.alloc(1536, 0);
    s1.writeUInt32BE(Math.floor(Date.now() / 1000), 0); // timestamp
    // bytes 4-7 are zeros (server version)
    // bytes 8-1535 random
    for (let i = 8; i < 1536; i++) s1[i] = Math.floor(Math.random() * 256);

    const s2 = buf.slice(1, 1537); // echo C1 back as S2

    socket.write(Buffer.concat([s0, s1, s2]), () => {
      handshakeDone = true;
      log('RTMP', 'Handshake OK — piping to FFmpeg');
      // Re-emit buffered data that came after the handshake
      const remaining = buf.slice(1537);
      startFFmpeg(socket);
      if (remaining.length > 0) {
        bytesIn += remaining.length;
        if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
          ffmpegProc.stdin.write(remaining);
        }
      }
    });
  });

  socket.on('timeout', () => {
    if (!handshakeDone) {
      log('RTMP', 'Handshake timeout, closing');
      socket.destroy();
    }
  });

  socket.on('error', err => log('RTMP', 'Error: ' + err.message));
});

rtmpServer.listen(CONFIG.rtmpPort, '0.0.0.0', () => {
  log('RTMP', 'Listening on port ' + CONFIG.rtmpPort);
});

rtmpServer.on('error', err => {
  if (err.code === 'EACCES') {
    log('ERROR', 'Port ' + CONFIG.rtmpPort + ' requires admin rights on Windows.');
    log('ERROR', 'Right-click server.js → "Run as administrator", or change rtmpPort to 19350.');
  } else {
    log('ERROR', 'RTMP server error: ' + err.message);
  }
  process.exit(1);
});

// ── HTTP Server — serves HLS + viewer page ────────────────────────────────────
const MIME_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/MP2T',
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const url = req.url.split('?')[0];

  // ── /api/status — polling endpoint for viewer ──
  if (url === '/api/status') {
    const uptime = streamStart ? Math.floor((Date.now() - streamStart) / 1000) : 0;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      live:        isStreaming,
      uptime,
      mbReceived:  (bytesIn / 1024 / 1024).toFixed(1),
    }));
    return;
  }

  // ── /hls/* — serve HLS segments + playlist ──
  if (url.startsWith('/hls/')) {
    const file = path.join(HLS_DIR, path.basename(url)); // basename = no path traversal
    if (fs.existsSync(file)) {
      const ext  = path.extname(file);
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // ── / — serve the viewer page ──
  if (url === '/' || url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(getViewerHTML());
    return;
  }

  res.writeHead(404); res.end('Not found');
});

httpServer.listen(CONFIG.httpPort, '0.0.0.0', () => {
  log('HTTP', 'Listening on port ' + CONFIG.httpPort);
});

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
function startCloudflaredTunnel() {
  log('Tunnel', 'Starting Cloudflare Tunnel for GoLive...');

  // cloudflared tunnel --url http://localhost:PORT
  const cf = spawn(CONFIG.cloudflaredPath, [
    'tunnel', '--url', 'http://localhost:' + CONFIG.httpPort,
    '--no-autoupdate',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Cloudflare prints the public URL to stderr
  const urlRegex = /https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i;

  function parseTunnelOutput(data) {
    const text = data.toString();
    const match = text.match(urlRegex);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      printBanner();
    }
  }

  cf.stdout.on('data', parseTunnelOutput);
  cf.stderr.on('data', parseTunnelOutput);

  cf.on('error', err => {
    if (err.code === 'ENOENT') {
      log('Tunnel', '*** cloudflared not found! ***');
      log('Tunnel', 'Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      log('Tunnel', 'Place cloudflared.exe in the same folder as server.js, or add it to PATH.');
      log('Tunnel', '');
      log('Tunnel', 'In the meantime, the viewer is available on your LOCAL network only:');
      tunnelUrl = null;
      printBanner();
    } else {
      log('Tunnel', 'Error: ' + err.message);
    }
  });

  cf.on('close', code => {
    log('Tunnel', 'Cloudflare tunnel closed (code ' + code + ')');
    tunnelUrl = null;
  });

  return cf;
}

// ── Startup Banner ────────────────────────────────────────────────────────────
function printBanner() {
  const ips = getLocalIPs();
  console.log('');
  console.log('  ════════════════════════════════════════════════════════');
  console.log('   GoLive v1.0.0 — GoPro Hero 13 Live Stream Server');
  console.log('  ════════════════════════════════════════════════════════');
  console.log('');
  console.log('  STEP 1 — Connect GoPro to same Wi-Fi as this PC');
  console.log('');
  console.log('  STEP 2 — In GoPro Quik app, set RTMP URL to:');
  ips.forEach(ip => {
    console.log('    rtmp://' + ip + ':' + CONFIG.rtmpPort + '/live/' + CONFIG.streamKey);
  });
  console.log('');
  if (tunnelUrl) {
    console.log('  STEP 3 — Open this URL on your device (works ANYWHERE):');
    console.log('');
    console.log('    ' + tunnelUrl);
    console.log('');
  } else {
    console.log('  STEP 3 — viewer URL (LOCAL network only):');
    ips.forEach(ip => {
      console.log('    http://' + ip + ':' + CONFIG.httpPort);
    });
    console.log('');
    console.log('  (Waiting for Cloudflare tunnel URL...)');
    console.log('');
  }
  console.log('  STEP 4 — Start streaming on your GoPro!');
  console.log('');
  console.log('  ════════════════════════════════════════════════════════');
  console.log('');
}

// Start tunnel, then print banner once URL is known (or after 15s timeout)
const cfProc = startCloudflaredTunnel();
setTimeout(() => { if (!tunnelUrl) printBanner(); }, 15000);

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  log('Server', 'Shutting down...');
  if (ffmpegProc) try { ffmpegProc.kill('SIGTERM'); } catch (_) {}
  if (cfProc)     try { cfProc.kill('SIGTERM');     } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
// Windows Ctrl+C
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('SIGINT', shutdown);
}

// ── Viewer HTML ─────────────────────────────────────────────────────────────────
function getViewerHTML() {
  // Note: No backtick template literals inside here — this string is already
  // inside a template literal in the outer server code, so we use ' and +.
  return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n' +
'<meta name="apple-mobile-web-app-capable" content="yes">\n' +
'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
'<title>GoLive</title>\n' +
'<style>\n' +
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\n' +
':root{\n' +
'  --bg:#080b10;\n' +
'  --surface:#0f1318;\n' +
'  --accent:#00e5ff;\n' +
'  --red:#ff2d55;\n' +
'  --text:#eceff4;\n' +
'  --muted:#4a5568;\n' +
'}\n' +
'html,body{height:100%;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;overflow:hidden;-webkit-tap-highlight-color:transparent}\n' +
'.app{display:flex;flex-direction:column;height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}\n' +
'\n' +
'/* Header */\n' +
'header{position:absolute;top:0;left:0;right:0;z-index:20;display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top) + 12px) 18px 12px;background:linear-gradient(to bottom,rgba(8,11,16,.95) 0%,transparent 100%)}\n' +
'.logo{display:flex;align-items:center;gap:9px}\n' +
'.logo-mark{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),#0070f3);border-radius:8px;display:grid;place-items:center;font-size:17px;flex-shrink:0}\n' +
'.logo-text{font-size:14px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}\n' +
'.badge{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;transition:all .3s}\n' +
'.badge.live{background:rgba(255,45,85,.15);border:1.5px solid rgba(255,45,85,.5);color:var(--red)}\n' +
'.badge.offline{background:rgba(74,85,104,.12);border:1.5px solid rgba(74,85,104,.3);color:var(--muted)}\n' +
'.dot{width:6px;height:6px;border-radius:50%;background:currentColor}\n' +
'.badge.live .dot{animation:blink 1.4s ease-in-out infinite}\n' +
'@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}\n' +
'\n' +
'/* Video */\n' +
'.stage{flex:1;position:relative;background:#000;display:flex;align-items:center;justify-content:center}\n' +
'video{width:100%;height:100%;object-fit:contain}\n' +
'\n' +
'/* Waiting */\n' +
'.wait{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;background:var(--bg);transition:opacity .4s,visibility .4s}\n' +
'.wait.gone{opacity:0;visibility:hidden}\n' +
'.spinner{position:relative;width:72px;height:72px}\n' +
'.ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid transparent}\n' +
'.ring:nth-child(1){border-top-color:var(--accent);animation:spin 2s linear infinite}\n' +
'.ring:nth-child(2){inset:10px;border-right-color:var(--red);animation:spin 1.4s linear infinite reverse}\n' +
'.ring:nth-child(3){inset:20px;border-bottom-color:var(--accent);animation:spin .9s linear infinite}\n' +
'.ring-icon{position:absolute;inset:0;display:grid;place-items:center;font-size:26px}\n' +
'@keyframes spin{to{transform:rotate(360deg)}}\n' +
'.wait-label{text-align:center}\n' +
'.wait-label h2{font-size:19px;font-weight:700;margin-bottom:5px}\n' +
'.wait-label p{font-size:13px;color:var(--muted);line-height:1.6;max-width:220px}\n' +
'\n' +
'/* Overlay controls */\n' +
'.overlay{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;background:linear-gradient(to top,rgba(8,11,16,.8) 0%,transparent 40%);padding:16px 20px;opacity:0;transition:opacity .25s;pointer-events:none}\n' +
'.overlay.show{opacity:1;pointer-events:auto}\n' +
'.overlay-row{display:flex;align-items:flex-end;justify-content:space-between}\n' +
'.stats-col{display:flex;flex-direction:column;gap:5px}\n' +
'.stat{font-size:11px;color:rgba(236,239,244,.6);font-variant-numeric:tabular-nums}\n' +
'.stat span{color:var(--accent);font-weight:600}\n' +
'.btns{display:flex;gap:10px}\n' +
'.cb{width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,.14);backdrop-filter:blur(12px);color:#fff;font-size:17px;cursor:pointer;display:grid;place-items:center;transition:background .15s,transform .1s}\n' +
'.cb:active{transform:scale(.9);background:rgba(255,255,255,.25)}\n' +
'\n' +
'/* Footer */\n' +
'footer{display:flex;justify-content:space-around;padding:10px 0 calc(env(safe-area-inset-bottom) + 8px);background:linear-gradient(to top,rgba(8,11,16,.96),transparent)}\n' +
'.metric{text-align:center}\n' +
'.metric-val{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);letter-spacing:-.01em}\n' +
'.metric-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}\n' +
'\n' +
'/* Reconnect banner */\n' +
'.reconnect{position:absolute;top:70px;left:50%;transform:translateX(-50%);background:rgba(255,45,85,.9);color:#fff;padding:8px 18px;border-radius:20px;font-size:12px;font-weight:700;opacity:0;transition:opacity .3s;white-space:nowrap;pointer-events:none}\n' +
'.reconnect.show{opacity:1}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="app">\n' +
'  <div class="stage" id="stage">\n' +
'\n' +
'    <!-- waiting screen -->\n' +
'    <div class="wait" id="wait">\n' +
'      <div class="spinner">\n' +
'        <div class="ring"></div>\n' +
'        <div class="ring"></div>\n' +
'        <div class="ring"></div>\n' +
'        <div class="ring-icon">&#x1F4F9;</div>\n' +
'      </div>\n' +
'      <div class="wait-label">\n' +
'        <h2>Waiting for GoPro</h2>\n' +
'        <p>Start streaming on your GoPro to begin the live feed on this device.</p>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- player -->\n' +
'    <video id="vid" playsinline webkit-playsinline muted autoplay preload="none"></video>\n' +
'\n' +
'    <!-- tap-to-show controls -->\n' +
'    <div class="overlay" id="overlay">\n' +
'      <div class="overlay-row">\n' +
'        <div class="stats-col">\n' +
'          <div class="stat">Uptime <span id="sUptime">--:--:--</span></div>\n' +
'          <div class="stat">Received <span id="sData">0 MB</span></div>\n' +
'          <div class="stat">Latency <span id="sLatency">~</span></div>\n' +
'        </div>\n' +
'        <div class="btns">\n' +
'          <button class="cb" id="muteBtn">&#x1F507;</button>\n' +
'          <button class="cb" id="fsBtn">&#x26F6;</button>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <div class="reconnect" id="reconnect">Reconnecting\u2026</div>\n' +
'  </div>\n' +
'\n' +
'  <!-- top bar (rendered over stage) -->\n' +
'  <header>\n' +
'    <div class="logo">\n' +
'      <div class="logo-mark">&#x1F3A5;</div>\n' +
'      <span class="logo-text">GoLive</span>\n' +
'    </div>\n' +
'    <div class="badge offline" id="badge">\n' +
'      <div class="dot"></div>\n' +
'      <span id="badgeTxt">Offline</span>\n' +
'    </div>\n' +
'  </header>\n' +
'\n' +
'  <!-- bottom metrics -->\n' +
'  <footer>\n' +
'    <div class="metric"><span class="metric-val" id="mRes">--</span><span class="metric-lbl">Resolution</span></div>\n' +
'    <div class="metric"><span class="metric-val" id="mFPS">--</span><span class="metric-lbl">Frame Rate</span></div>\n' +
'    <div class="metric"><span class="metric-val" id="mStatus">--</span><span class="metric-lbl">Status</span></div>\n' +
'  </footer>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'(function(){\n' +
'"use strict";\n' +
'var HLS_URL = "/hls/stream.m3u8";\n' +
'var POLL    = 3000;\n' +
'var hls=null, live=false, muted=true, ctTimer=null;\n' +
'\n' +
'var vid     = document.getElementById("vid");\n' +
'var wait    = document.getElementById("wait");\n' +
'var badge   = document.getElementById("badge");\n' +
'var badgeTxt= document.getElementById("badgeTxt");\n' +
'var overlay = document.getElementById("overlay");\n' +
'var reconnEl= document.getElementById("reconnect");\n' +
'var muteBtn = document.getElementById("muteBtn");\n' +
'var fsBtn   = document.getElementById("fsBtn");\n' +
'var sUptime = document.getElementById("sUptime");\n' +
'var sData   = document.getElementById("sData");\n' +
'var sLatency= document.getElementById("sLatency");\n' +
'var mRes    = document.getElementById("mRes");\n' +
'var mFPS    = document.getElementById("mFPS");\n' +
'var mStatus = document.getElementById("mStatus");\n' +
'\n' +
'function fmtTime(s){\n' +
'  var h=String(Math.floor(s/3600)).padStart(2,"0");\n' +
'  var m=String(Math.floor((s%3600)/60)).padStart(2,"0");\n' +
'  var sc=String(s%60).padStart(2,"0");\n' +
'  return h+":"+m+":"+sc;\n' +
'}\n' +
'\n' +
'function loadHlsJs(cb){\n' +
'  if(window.Hls) return cb();\n' +
'  var s=document.createElement("script");\n' +
'  s.src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";\n' +
'  s.onload=cb;\n' +
'  s.onerror=cb; // fall back to native\n' +
'  document.head.appendChild(s);\n' +
'}\n' +
'\n' +
'function startPlay(){\n' +
'  if(live) return;\n' +
'  live=true;\n' +
'  wait.classList.add("gone");\n' +
'  badge.className="badge live";\n' +
'  badgeTxt.textContent="Live";\n' +
'  mStatus.textContent="Live";\n' +
'  reconnEl.classList.remove("show");\n' +
'\n' +
'  loadHlsJs(function(){\n' +
'    if(window.Hls && Hls.isSupported()){\n' +
'      hls=new Hls({\n' +
'        lowLatencyMode:true,\n' +
'        backBufferLength:4,\n' +
'        maxBufferLength:8,\n' +
'        liveSyncDurationCount:2,\n' +
'        liveMaxLatencyDurationCount:5\n' +
'      });\n' +
'      hls.loadSource(HLS_URL);\n' +
'      hls.attachMedia(vid);\n' +
'      hls.on(Hls.Events.MANIFEST_PARSED,function(){vid.play();});\n' +
'      hls.on(Hls.Events.FRAG_LOADED,function(e,d){\n' +
'        var lat=Math.round(d.frag.stats.loading.end-d.frag.stats.loading.start);\n' +
'        sLatency.textContent=lat+"ms";\n' +
'      });\n' +
'      hls.on(Hls.Events.ERROR,function(e,d){\n' +
'        if(d.fatal){stopPlay();reconnEl.classList.add("show");}\n' +
'      });\n' +
'    } else if(vid.canPlayType("application/vnd.apple.mpegurl")){\n' +
'      // Native HLS — Safari / mobile browsers\n' +
'      vid.src=HLS_URL;\n' +
'      vid.play();\n' +
'    }\n' +
'  });\n' +
'\n' +
'  vid.addEventListener("loadedmetadata",function(){\n' +
'    mRes.textContent=vid.videoWidth+"x"+vid.videoHeight;\n' +
'  });\n' +
'}\n' +
'\n' +
'function stopPlay(){\n' +
'  if(!live) return;\n' +
'  live=false;\n' +
'  if(hls){hls.destroy();hls=null;}\n' +
'  vid.src="";\n' +
'  wait.classList.remove("gone");\n' +
'  badge.className="badge offline";\n' +
'  badgeTxt.textContent="Offline";\n' +
'  mRes.textContent="--";\n' +
'  mFPS.textContent="--";\n' +
'  mStatus.textContent="--";\n' +
'}\n' +
'\n' +
'function poll(){\n' +
'  fetch("/api/status")\n' +
'    .then(function(r){return r.json();})\n' +
'    .then(function(d){\n' +
'      if(d.live && !live) startPlay();\n' +
'      if(!d.live && live) stopPlay();\n' +
'      if(d.live){\n' +
'        sUptime.textContent=fmtTime(d.uptime);\n' +
'        sData.textContent=d.mbReceived+" MB";\n' +
'      }\n' +
'    })\n' +
'    .catch(function(){/* network blip, ignore */});\n' +
'}\n' +
'\n' +
'// FPS counter using requestVideoFrameCallback (supported on iOS 15.1+)\n' +
'var fpsFrames=0, fpsLast=0;\n' +
'function countFPS(now){\n' +
'  fpsFrames++;\n' +
'  if(now-fpsLast>=1000){\n' +
'    if(live) mFPS.textContent=fpsFrames+"fps";\n' +
'    fpsFrames=0; fpsLast=now;\n' +
'  }\n' +
'  if(live && vid.requestVideoFrameCallback)\n' +
'    vid.requestVideoFrameCallback(countFPS);\n' +
'}\n' +
'vid.addEventListener("play",function(){\n' +
'  if(vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(countFPS);\n' +
'});\n' +
'\n' +
'// Controls\n' +
'muteBtn.addEventListener("click",function(){\n' +
'  muted=!muted; vid.muted=muted;\n' +
'  muteBtn.innerHTML=muted?"&#x1F507;":"&#x1F50A;";\n' +
'});\n' +
'\n' +
'fsBtn.addEventListener("click",function(){\n' +
'  var el=document.documentElement;\n' +
'  var req=el.requestFullscreen||el.webkitRequestFullscreen;\n' +
'  var ex=document.exitFullscreen||document.webkitExitFullscreen;\n' +
'  if(document.fullscreenElement||document.webkitFullscreenElement)\n' +
'    ex.call(document);\n' +
'  else if(req) req.call(el);\n' +
'});\n' +
'\n' +
'document.getElementById("stage").addEventListener("click",function(){\n' +
'  overlay.classList.add("show");\n' +
'  clearTimeout(ctTimer);\n' +
'  ctTimer=setTimeout(function(){overlay.classList.remove("show");},3500);\n' +
'});\n' +
'\n' +
'poll();\n' +
'setInterval(poll, POLL);\n' +
'})();\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}
