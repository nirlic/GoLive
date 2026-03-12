@echo off
title GoLive v1.1.0
color 0A

echo.
echo  ================================================
echo   GoLive v1.1.0  by Nirlicnick
echo  ================================================
echo.
echo  Checking requirements...
echo.

REM ── Check Node.js ────────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found!
    echo  Download from: https://nodejs.org
    echo.
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v

REM ── Check FFmpeg ─────────────────────────────────────────────────────────────
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [WARNING] FFmpeg not found in PATH.
    echo  Set ffmpegPath in config.json, or add ffmpeg to PATH.
    echo  Download: https://www.gyan.dev/ffmpeg/builds/
    echo.
) else (
    echo  [OK] FFmpeg found
)

REM ── Check cloudflared ────────────────────────────────────────────────────────
cloudflared --version >nul 2>&1
if errorlevel 1 (
    if exist "%~dp0cloudflared.exe" (
        echo  [OK] cloudflared.exe found in folder
    ) else (
        echo.
        echo  [WARNING] cloudflared.exe not found.
        echo  Remote access will not work until you add cloudflared.exe to this folder.
        echo  Download: https://github.com/cloudflare/cloudflared/releases/latest
        echo  Get cloudflared-windows-amd64.exe and rename it to cloudflared.exe
        echo.
    )
) else (
    echo  [OK] cloudflared found
)

echo.
echo  ================================================
echo.
echo  How would you like to run GoLive?
echo.
echo    [1] Normal  ^- open console window (default)
echo    [2] Tray    ^- minimize to system tray, run in background
echo.
set /p MODE="  Enter 1 or 2 (or press Enter for normal): "

if "%MODE%"=="2" goto TRAY
goto NORMAL

REM ── Normal mode ──────────────────────────────────────────────────────────────
:NORMAL
echo.
echo  Starting GoLive...
echo  Press Ctrl+C to stop.
echo.
node "%~dp0server.js"
pause
exit /b 0

REM ── Tray mode ─────────────────────────────────────────────────────────────────
:TRAY
echo.
echo  Starting GoLive in tray mode...
echo  Look for the camera icon in your system tray (bottom-right corner).
echo  Right-click the tray icon to open viewer, copy URL, or stop.
echo.

start "" powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"

echo  GoLive is running in the background.
echo  To stop it: right-click the tray icon and choose "Stop GoLive"
echo.
timeout /t 3 >nul
exit /b 0
