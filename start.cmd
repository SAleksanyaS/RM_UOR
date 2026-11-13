@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 20.19 or later is required. Install it and run this file again.
  pause
  exit /b 1
)
node scripts/start-workspace.mjs
if errorlevel 1 pause
