@echo off
title AI Training Planner - http://127.0.0.1:8787
cd /d "%~dp0"

echo ============================================
echo   AI Training Planner
echo   Web UI : http://127.0.0.1:8787
echo   Stop   : close this window or Ctrl+C
echo ============================================
echo.

rem If the server is already listening, just open the page.
rem (Starting a second one would only produce a pile of EADDRINUSE errors.)
netstat -ano | findstr "127.0.0.1:8787" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [already running] opening the page...
  start "" http://127.0.0.1:8787
  timeout /t 3 /nobreak >nul
  exit /b 0
)

rem 2 seconds later, open browser (server needs a moment to boot)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8787"

rem Node 解释器：优先用项目内的 node，否则回退到 WorkBuddy 托管的 node 版本。
set "NODE_EXE="
if exist "%~dp0.node\node.exe" set "NODE_EXE=%~dp0.node\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-5\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-5\node.exe"
if not defined NODE_EXE set "NODE_EXE=node"

"%NODE_EXE%" dist\server\index.js

echo.
echo Server stopped.
pause
