@echo off
title GoLive v1.0.0
color 0A

echo.
echo  GoLive v1.0.0 by Nirlicnick — Checking requirements...
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found!
    echo  Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v

REM Check FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [WARNING] FFmpeg not found in PATH.
    echo  If you have it installed elsewhere, edit server.js and set:
    echo    Set ffmpegPath in config.json
    echo.
    echo  Or download FFmpeg from: https://www.gyan.dev/ffmpeg/builds/
    echo  Extract and add the bin\ folder to your system PATH.
    echo.
) else (
    echo  [OK] FFmpeg found
)

REM Check cloudflared
cloudflared --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [WARNING] cloudflared.exe not found in PATH or this folder.
    echo  GoLive viewer will only be accessible on your LOCAL network.
    echo.
    echo  To enable remote iPhone access:
    echo  1. Download cloudflared.exe from:
    echo     https://github.com/cloudflare/cloudflared/releases/latest
    echo     (get: cloudflared-windows-amd64.exe, rename to cloudflared.exe)
    echo  2. Place cloudflared.exe in the same folder as server.js
    echo.
) else (
    echo  [OK] cloudflared found
)

echo.
echo  Starting server...
echo  Press Ctrl+C to stop.
echo.

node server.js

pause
