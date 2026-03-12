# 🎥 GoLive v1.0.0 — GoPro Hero 13 Live Stream Server

Stream your GoPro Hero 13 Black live to **any device, anywhere in the world** — no cloud subscription, no monthly fees.

---

## How It Works

```
GoPro Hero 13  ──RTMP──▶  server.js  ──HLS──▶  Cloudflare Tunnel  ──HTTPS──▶  Any Device
  (Wi-Fi)                (Windows PC)                (internet)               (anywhere)
```

- GoPro streams RTMP video to your PC over local Wi-Fi
- `server.js` uses FFmpeg to convert it to HLS (plays natively in Safari and most mobile browsers)
- Cloudflare Tunnel creates a secure public HTTPS URL — no router config, no port forwarding
- Any device opens that URL in a browser and watches the live feed from anywhere

---

## One-Time Setup

### 1. Install Node.js
Download and install from https://nodejs.org (LTS version)

### 2. Confirm FFmpeg is working
Open Command Prompt and run:
```
ffmpeg -version
```
If you see version info, you're good.  
If not, see **FFmpeg Troubleshooting** below.

### 3. Download cloudflared.exe
1. Go to: https://github.com/cloudflare/cloudflared/releases/latest
2. Download **`cloudflared-windows-amd64.exe`**
3. Rename it to **`cloudflared.exe`**
4. Place it in the **same folder as `server.js`**

> You do NOT need a Cloudflare account — it uses their free Quick Tunnels.

---

## Running the Server

Double-click **`start.bat`**

Or open Command Prompt in this folder and run:
```
node server.js
```

You'll see something like:

```
  ════════════════════════════════════════════════════════
   GoPro Hero 13 — Live Stream Server  (Windows Edition)
  ════════════════════════════════════════════════════════

  STEP 1 — Connect GoPro to same Wi-Fi as this PC

  STEP 2 — In GoPro Quik app, set RTMP URL to:
    rtmp://192.168.1.42:1935/live/gopro

  STEP 3 — Open this URL on any device (works ANYWHERE):
    https://random-words-here.trycloudflare.com

  STEP 4 — Start streaming on your GoPro!
```

---

## Configuring the GoPro Hero 13

**Using the GoPro Quik app (recommended):**
1. Open Quik → tap your Hero 13 → Controls
2. Tap **Livestream**
3. Set platform to **RTMP**
4. Enter the RTMP URL shown in your terminal:
   `rtmp://YOUR-PC-IP:1935/live/gopro`
5. Recommended quality: **1080p / 30fps**
6. Tap **Go Live**

**Directly on the camera:**
1. Swipe down for Settings → Connections → Live Streaming
2. Set stream URL to the RTMP address above

---

## Watching on Any Device

Open any browser on any device and go to the `https://...trycloudflare.com` URL shown in your terminal.

- The page auto-detects when the GoPro starts/stops streaming
- Tap the screen to show controls (mute, fullscreen, stats)
- Works on any device, over 4G/5G, any Wi-Fi — anywhere in the world
- **Note:** The tunnel URL changes each time you restart the server — share it fresh each session, or keep the terminal open

---

## Firewall Note

Windows Firewall may ask to allow Node.js network access when you first run the server. Click **Allow** for both private and public networks.

If the GoPro can't connect, also allow port 1935:
1. Windows Defender Firewall → Advanced Settings
2. Inbound Rules → New Rule → Port → TCP → 1935
3. Allow the connection

---

## FFmpeg Troubleshooting

**FFmpeg not in PATH:**
1. Download from https://www.gyan.dev/ffmpeg/builds/ → "release builds" → `ffmpeg-release-full.7z`
2. Extract to `C:\ffmpeg\`
3. Add `C:\ffmpeg\bin` to your system PATH:
   - Search "Environment Variables" in Start
   - System Properties → Environment Variables
   - Under "System variables" → Path → Edit → New → `C:\ffmpeg\bin`
4. Restart Command Prompt, run `ffmpeg -version`

**OR** skip PATH setup and hardcode it in `server.js`:
```js
ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
```

---

## Configuration

Edit the `CONFIG` block near the top of `server.js`:

```js
const CONFIG = {
  rtmpPort:    1935,          // Port GoPro streams to (change if blocked)
  httpPort:    8080,          // Local HTTP port
  streamKey:   'gopro',       // Must match end of your RTMP URL
  ffmpegPath:  'ffmpeg',      // Or full path: 'C:\\ffmpeg\\bin\\ffmpeg.exe'
  hlsTime:     2,             // Segment size in seconds (lower = less latency)
  hlsListSize: 5,             // Segments in HLS playlist
  cloudflaredPath: 'cloudflared',  // Or full path to cloudflared.exe
};
```

---

## Latency

Expected end-to-end latency over the internet: **8–15 seconds**  
Over local Wi-Fi: **4–8 seconds**

This is normal for HLS streaming. It prioritises reliability and broad device compatibility.

---

## File Structure

```
GoLive-v1.0.0\
├── server.js          ← Main server
├── start.bat          ← Double-click launcher for Windows
├── cloudflared.exe    ← Place here after downloading
├── README.md          ← This file
└── hls\               ← Created automatically when streaming starts
    ├── stream.m3u8
    └── seg00001.ts ...
```

---

## Credits

Developed by **Nirlicnick** · v1.0.0
