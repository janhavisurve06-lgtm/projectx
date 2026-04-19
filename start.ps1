# ============================================================
# MeetPulse startup script for Windows
# ============================================================
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Cyan
Write-Host '  MeetPulse Backend - Quick Start' -ForegroundColor Cyan
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Cyan

$backendDir = "$PSScriptRoot\backend"

# Check if venv exists
if (-not (Test-Path "$backendDir\venv")) {
    Write-Host 'Creating Python virtual environment...' -ForegroundColor Yellow
    python -m venv "$backendDir\venv"
}

# Activate venv
& "$backendDir\venv\Scripts\Activate.ps1"

# Install requirements
Write-Host 'Installing dependencies...' -ForegroundColor Yellow
pip install -r "$backendDir\requirements.txt" -q

# Run server
Write-Host 'Starting MeetPulse backend on http://localhost:8000' -ForegroundColor Green
Set-Location $backendDir
python main.py
