@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then try again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

rem A second `npm run dev` would make concurrently stop every child when the
rem already-running API cannot bind 3030. In that common development case only
rem the Vite page is missing, so bring it back without touching workers.
curl.exe -fsS http://127.0.0.1:3030/api/health >nul 2>nul
if not errorlevel 1 (
  curl.exe -fsS http://127.0.0.1:5173/ >nul 2>nul
  if not errorlevel 1 (
    echo Page Watch is already running: http://127.0.0.1:5173
    exit /b 0
  )
  echo Page Watch API is already running. Starting the missing web page on port 5173...
  call npm.cmd run dev:web
  exit /b %errorlevel%
)

echo Starting Page Watch, check, release-date, magnet lookup and qBittorrent download Workers...
call npm.cmd run dev
