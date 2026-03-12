# GoLive v1.1.0 — System Tray Launcher
# ───────────────────────────────────────
# Runs server.js silently in the background and shows a system tray icon.
# Right-click the tray icon for options.
#
# Usage: Right-click tray.ps1 → Run with PowerShell
#   OR:  powershell -ExecutionPolicy Bypass -File tray.ps1
#
# Developed by Nirlicnick

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Locate files ──────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ServerScript = Join-Path $ScriptDir "server.js"

if (-not (Test-Path $ServerScript)) {
    [System.Windows.Forms.MessageBox]::Show(
        "server.js not found in: $ScriptDir`nMake sure tray.ps1 is in the same folder as server.js.",
        "GoLive - Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# ── Check Node.js ─────────────────────────────────────────────────────────────
$nodePath = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodePath) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js not found. Please install it from https://nodejs.org",
        "GoLive - Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# ── State ─────────────────────────────────────────────────────────────────────
$ServerProcess = $null
$TunnelUrl     = $null
$IsLive        = $false
$LogLines      = [System.Collections.Generic.List[string]]::new()
$HttpPort      = 8080  # default, updated if config.json found

# Read port from config.json if available
$ConfigFile = Join-Path $ScriptDir "config.json"
if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content $ConfigFile | ConvertFrom-Json
        if ($cfg.httpPort) { $HttpPort = $cfg.httpPort }
    } catch {}
}

# ── Create tray icon using a drawn camera icon ────────────────────────────────
function New-TrayIcon([string]$color) {
    $bmp = [System.Drawing.Bitmap]::new(16, 16)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $c   = [System.Drawing.Color]::FromName($color)
    if ($color -eq "live") { $c = [System.Drawing.Color]::FromArgb(255, 45, 85) }
    else                    { $c = [System.Drawing.Color]::FromArgb(0, 180, 220) }
    $brush = [System.Drawing.SolidBrush]::new($c)
    # Draw camera body
    $g.FillRoundedRectangle = $null
    $g.FillRectangle($brush, 1, 4, 10, 8)
    # Lens
    $lensBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $g.FillEllipse($lensBrush, 3, 5, 6, 6)
    $lensInner = [System.Drawing.SolidBrush]::new($c)
    $g.FillEllipse($lensInner, 4, 6, 4, 4)
    # Viewfinder bump
    $g.FillRectangle($brush, 8, 2, 3, 3)
    # Video side triangles (to look like a camera)
    $pts = @(
        [System.Drawing.Point]::new(11, 5),
        [System.Drawing.Point]::new(14, 7),
        [System.Drawing.Point]::new(11, 9)
    )
    $g.FillPolygon($brush, $pts)
    $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

# ── Build tray components ─────────────────────────────────────────────────────
$NotifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$NotifyIcon.Text    = "GoLive v1.1.0"
$NotifyIcon.Visible = $true
$NotifyIcon.Icon    = [System.Drawing.SystemIcons]::Application  # fallback

try { $NotifyIcon.Icon = New-TrayIcon "idle" } catch {}

$ContextMenu = [System.Windows.Forms.ContextMenuStrip]::new()

$menuTitle = [System.Windows.Forms.ToolStripMenuItem]::new("GoLive v1.1.0  by Nirlicnick")
$menuTitle.Enabled = $false
$menuTitle.Font = [System.Drawing.Font]::new("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)

$menuSep1    = [System.Windows.Forms.ToolStripSeparator]::new()
$menuStatus  = [System.Windows.Forms.ToolStripMenuItem]::new("Status: Starting...")
$menuStatus.Enabled = $false

$menuSep2    = [System.Windows.Forms.ToolStripSeparator]::new()
$menuOpenViewer = [System.Windows.Forms.ToolStripMenuItem]::new("Open Viewer in Browser")
$menuCopyUrl    = [System.Windows.Forms.ToolStripMenuItem]::new("Copy Viewer URL")
$menuOpenSetup  = [System.Windows.Forms.ToolStripMenuItem]::new("Open Setup Page")
$menuShowLog    = [System.Windows.Forms.ToolStripMenuItem]::new("Show Console Log")

$menuSep3   = [System.Windows.Forms.ToolStripSeparator]::new()
$menuStop   = [System.Windows.Forms.ToolStripMenuItem]::new("Stop GoLive")
$menuStop.ForeColor = [System.Drawing.Color]::FromArgb(220, 50, 50)

$ContextMenu.Items.AddRange(@(
    $menuTitle, $menuSep1, $menuStatus,
    $menuSep2, $menuOpenViewer, $menuCopyUrl, $menuOpenSetup, $menuShowLog,
    $menuSep3, $menuStop
))
$NotifyIcon.ContextMenuStrip = $ContextMenu

# ── Log window ────────────────────────────────────────────────────────────────
$LogForm = $null

function Show-Log {
    if ($LogForm -and -not $LogForm.IsDisposed) {
        $LogForm.BringToFront(); return
    }
    $LogForm = [System.Windows.Forms.Form]::new()
    $LogForm.Text = "GoLive Console"
    $LogForm.Size = [System.Drawing.Size]::new(700, 400)
    $LogForm.BackColor = [System.Drawing.Color]::FromArgb(8, 11, 16)
    $LogForm.StartPosition = "CenterScreen"

    $tb = [System.Windows.Forms.RichTextBox]::new()
    $tb.Dock = "Fill"
    $tb.BackColor = [System.Drawing.Color]::FromArgb(8, 11, 16)
    $tb.ForeColor = [System.Drawing.Color]::FromArgb(0, 229, 255)
    $tb.Font = [System.Drawing.Font]::new("Consolas", 9)
    $tb.ReadOnly = $true
    $tb.Text = ($LogLines -join "`r`n")
    $tb.SelectionStart = $tb.Text.Length
    $tb.ScrollToCaret()
    $LogForm.Controls.Add($tb)
    $LogForm.Show()
}

# ── Start server process ───────────────────────────────────────────────────────
function Start-Server {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = "node"
    $psi.Arguments              = "`"$ServerScript`""
    $psi.WorkingDirectory       = $ScriptDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    $script:ServerProcess = [System.Diagnostics.Process]::new()
    $script:ServerProcess.StartInfo           = $psi
    $script:ServerProcess.EnableRaisingEvents = $true

    # Capture stdout
    $script:ServerProcess.add_OutputDataReceived({
        param($s, $e)
        if ($e.Data) {
            $script:LogLines.Add($e.Data)
            if ($script:LogLines.Count -gt 500) { $script:LogLines.RemoveAt(0) }

            # Extract tunnel URL
            if ($e.Data -match "https://[a-z0-9-]+\.trycloudflare\.com") {
                $script:TunnelUrl = $matches[0]
                $script:NotifyIcon.Text = "GoLive — $($script:TunnelUrl)"
                $script:menuStatus.Text = "Tunnel: Ready"
                $script:NotifyIcon.ShowBalloonTip(
                    4000, "GoLive Ready",
                    "Watch at: $($script:TunnelUrl)",
                    [System.Windows.Forms.ToolTipIcon]::Info
                )
            }
            # Detect live stream
            if ($e.Data -match "LIVE") {
                $script:IsLive = $true
                $script:menuStatus.Text = "Stream: LIVE"
                try { $script:NotifyIcon.Icon = New-TrayIcon "live" } catch {}
            }
        }
    })

    # Capture stderr (FFmpeg progress goes here)
    $script:ServerProcess.add_ErrorDataReceived({
        param($s, $e)
        if ($e.Data) {
            $script:LogLines.Add($e.Data)
            if ($script:LogLines.Count -gt 500) { $script:LogLines.RemoveAt(0) }
        }
    })

    $script:ServerProcess.add_Exited({
        $script:menuStatus.Text = "Status: Stopped"
        $script:NotifyIcon.Text = "GoLive v1.1.0 (stopped)"
    })

    $script:ServerProcess.Start() | Out-Null
    $script:ServerProcess.BeginOutputReadLine()
    $script:ServerProcess.BeginErrorReadLine()
    $script:menuStatus.Text = "Status: Running (port $HttpPort)"
}

# ── Menu actions ──────────────────────────────────────────────────────────────
$menuOpenViewer.add_Click({
    $url = if ($TunnelUrl) { $TunnelUrl } else { "http://localhost:$HttpPort" }
    Start-Process $url
})

$menuCopyUrl.add_Click({
    $url = if ($TunnelUrl) { $TunnelUrl } else { "http://localhost:$HttpPort" }
    [System.Windows.Forms.Clipboard]::SetText($url)
    $NotifyIcon.ShowBalloonTip(2000, "GoLive", "URL copied to clipboard!", [System.Windows.Forms.ToolTipIcon]::Info)
})

$menuOpenSetup.add_Click({
    $url = if ($TunnelUrl) { "$TunnelUrl/setup" } else { "http://localhost:$HttpPort/setup" }
    Start-Process $url
})

$menuShowLog.add_Click({ Show-Log })

$menuStop.add_Click({
    if ($ServerProcess -and -not $ServerProcess.HasExited) {
        $ServerProcess.Kill()
    }
    $NotifyIcon.Visible = $false
    $NotifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Double-click opens viewer
$NotifyIcon.add_DoubleClick({
    $url = if ($TunnelUrl) { $TunnelUrl } else { "http://localhost:$HttpPort" }
    Start-Process $url
})

# ── Start and run ─────────────────────────────────────────────────────────────
Start-Server

$NotifyIcon.ShowBalloonTip(
    3000, "GoLive Starting",
    "Server is starting up. Double-click the tray icon to open viewer.",
    [System.Windows.Forms.ToolTipIcon]::Info
)

# Run the Windows message loop (keeps tray alive)
[System.Windows.Forms.Application]::Run()

# Cleanup on exit
if ($ServerProcess -and -not $ServerProcess.HasExited) { $ServerProcess.Kill() }
$NotifyIcon.Dispose()
