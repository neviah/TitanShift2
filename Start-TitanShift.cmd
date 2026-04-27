@echo off
setlocal
cd /d "%~dp0"

echo Starting TitanShift stack...
echo.

echo [1/4] Starting OpenCode upstream on port 4096...
start "OpenCode Upstream" cmd /k "cd /d "%~dp0opencode-upstream" && bun run dev"

echo [2/4] Starting bridge on port 8000...
start "TitanShift Bridge" cmd /k "cd /d "%~dp0" && npm --prefix bridge run dev"

echo [3/4] Starting UI on port 5173...
start "TitanShift UI" cmd /k "cd /d "%~dp0" && npm --prefix ui run dev -- --host 127.0.0.1"

echo [4/4] Opening browser...
start "" "http://127.0.0.1:5173"

echo.
echo TitanShift launch requested.
echo If a window shows a missing-tool error, install the dependency first:
echo - bun for opencode-upstream
echo - npm dependencies for bridge and ui
echo.
pause
