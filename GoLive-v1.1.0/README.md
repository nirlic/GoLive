# GoLive v1.1.0
### GoPro Hero 13 Live Stream Server
Developed by **Nirlicnick**

Stream your GoPro Hero 13 Black live to any device, anywhere in the world. No cloud subscription, no monthly fees.

---

## Requirements

- **Windows 10 or 11**
- **Node.js** — https://nodejs.org (LTS version)
- **FFmpeg** — https://www.gyan.dev/ffmpeg/builds
- **cloudflared.exe** — place in this folder (see Remote Access below)

---

## Quick Start

1. Install Node.js and FFmpeg
2. Open `config.json` and set your password
3. Double-click `start.bat`
4. Connect your GoPro to the same Wi-Fi as your PC
5. Set the GoPro RTMP URL to the address shown in the terminal
6. Start streaming on your GoPro
7. Open the viewer URL on any device

---

## Setting a Password

Open `config.json` and change the password:

```json
{
  "users": [
    { "username": "golive", "password": "your-password-here" }
  ]
}
```

When someone opens the viewer URL they will be prompted to log in. The browser remembers credentials after the first entry.

---

## Remote Access (Cloudflare Tunnel)

To watch the stream from outside your home network:

1. Go to https://github.com/cloudflare/cloudflared/releases/latest
2. Download `cloudflared-windows-amd64.exe`
3. Rename it to `cloudflared.exe`
4. Place it in the same folder as `server.js`

GoLive will automatically create a secure public URL when it starts. No Cloudflare account needed.

---

## Configuring the GoPro Hero 13

**Using the GoPro Quik app:**
1. Open Quik and tap your Hero 13
2. Go to Controls → Livestream
3. Set platform to RTMP
4. Enter the RTMP URL shown in the terminal on startup
5. Set quality to 1080p / 30fps
6. Tap Go Live

---

## Running GoLive

Double-click `start.bat`. You will be asked how to run:

- **Normal** — console window stays open. You can see logs, the viewer URL, and the RTMP address. Press Ctrl+C to stop.
- **Tray** — GoLive runs silently in the background. A camera icon appears in the system tray (bottom-right corner). Right-click it to open the viewer, copy the URL, or stop the server.

You can switch between modes any time by stopping and restarting.

---

## Setup Page

Once running, open `/setup` in your browser (e.g. `http://YOUR-URL/setup`) to:

- Add or remove users and change passwords
- Generate time-limited shareable links
- Enable or disable stream recording
- Adjust stream settings
- View a list of saved recordings
- See a live QR code for the viewer URL

---

## Stream Recording

Enable recording in `config.json`:

```json
{ "record": true }
```

Or toggle it on the Setup page. Recordings are saved as MP4 files in the `recordings/` folder, named by date and time.

---

## Time-Limited Links

You can generate a link that expires after a set number of hours, useful for sharing with someone temporarily without giving them your password.

Set the expiry in `config.json`:

```json
{ "linkExpiryHours": 24 }
```

Then click Generate Link on the Setup page. Set to `0` for links that never expire.

---

## Multiple Users

Add more users in `config.json`:

```json
{
  "users": [
    { "username": "admin",  "password": "strong-password" },
    { "username": "viewer", "password": "viewer-password" }
  ]
}
```

Or manage users from the Setup page without editing the file.

---

## FFmpeg Setup

If `ffmpeg -version` does not work in Command Prompt:

1. Download from https://www.gyan.dev/ffmpeg/builds — choose `ffmpeg-release-full.7z`
2. Extract to `C:\ffmpeg\`
3. Add `C:\ffmpeg\bin` to your system PATH:
   - Open Start and search for Environment Variables
   - Go to System Properties → Environment Variables
   - Under System variables, select Path → Edit → New → type `C:\ffmpeg\bin`
4. Restart Command Prompt and run `ffmpeg -version`

Alternatively, set the full path in `config.json`:

```json
{ "ffmpegPath": "C:\\ffmpeg\\bin\\ffmpeg.exe" }
```

---

## Firewall

Windows Firewall may prompt when GoLive first runs. Click Allow for both private and public networks.

To manually open the RTMP port:

1. Open Windows Defender Firewall → Advanced Settings
2. Inbound Rules → New Rule → Port → TCP → 1935 → Allow

---

## Configuration Reference

All settings live in `config.json`. No need to edit `server.js`.

| Setting | Default | Description |
|---------|---------|-------------|
| `users` | — | Array of `{username, password}` objects |
| `ffmpegPath` | `ffmpeg` | Path to ffmpeg.exe |
| `cloudflaredPath` | `cloudflared` | Path to cloudflared.exe |
| `rtmpPort` | `1935` | Port the GoPro streams to |
| `httpPort` | `8080` | Local HTTP port for the viewer |
| `streamKey` | `golive` | Must match the end of your RTMP URL |
| `hlsTime` | `2` | Segment length in seconds (lower = less latency) |
| `hlsListSize` | `5` | Number of segments kept in the playlist |
| `record` | `false` | Save stream as MP4 while live |
| `linkExpiryHours` | `0` | Hours before generated links expire (0 = never) |

---

## Expected Latency

- Local Wi-Fi: 4 to 8 seconds
- Remote over internet: 8 to 15 seconds

This is normal for HLS streaming. It prioritises reliability and compatibility across all devices and browsers.

---

## File Structure

```
GoLive-v1.1.0\
├── server.js          - Main server
├── config.json        - Your settings, set password here
├── start.bat          - Launcher, choose normal or tray mode
├── tray.ps1           - System tray script
├── cloudflared.exe    - Place here after downloading
├── README.md          - This file
├── recordings\        - Created when recording is enabled
└── hls\               - Created automatically while streaming
```

---

## Changelog

### v1.1.0
- Added QR code style URL box in terminal on startup
- Added automatic stream recovery when GoPro disconnects and reconnects
- Added optional MP4 stream recording to the recordings folder
- Added Picture-in-Picture button in the viewer
- Added live viewer count shown in the viewer and terminal
- Added snapshot button to save a still frame from the live feed
- Added time-limited shareable link generation
- Added multi-user password support
- Added web-based Setup page at /setup for managing all settings
- Added system tray mode, accessible via start.bat or tray.ps1 directly

### v1.0.0
- Initial release
- RTMP input from GoPro Hero 13 over local Wi-Fi
- HLS transcoding via FFmpeg
- Remote access via Cloudflare Tunnel
- Password protection via HTTP Basic Auth
- Viewer page compatible with all modern browsers and devices
- Windows batch launcher with requirement checks
