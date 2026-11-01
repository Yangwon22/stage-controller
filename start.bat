@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org & pause & exit /b)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
node server.js
pause
