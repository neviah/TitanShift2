@echo off
setlocal
cd /d "%~dp0"

echo Starting TitanShift stack...
echo.

where bun >nul 2>nul
if errorlevel 1 (
	echo [ERROR] Bun is not installed or not in PATH.
	echo Install Bun first: https://bun.sh/
	pause
	exit /b 1
)

echo [1/5] Preparing OpenCode dependencies...
if not exist "%~dp0opencode-upstream\node_modules" (
	echo Running bun install in opencode-upstream...
	pushd "%~dp0opencode-upstream"
	call bun install --ignore-scripts
	popd
	if errorlevel 1 (
		echo [ERROR] bun install failed for opencode-upstream.
		pause
		exit /b 1
	)
)

echo [2/5] Starting OpenCode upstream on port 4096...
start "OpenCode Upstream" cmd /k "cd /d ""%~dp0opencode-upstream"" && bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096"

echo Waiting for OpenCode health endpoint...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(45); $ok=$false; while((Get-Date)-lt $deadline){ try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:4096/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -ge 200){ $ok=$true; break } } catch {}; Start-Sleep -Milliseconds 700 }; if($ok){ exit 0 } else { exit 1 }"
if errorlevel 1 (
	echo [WARN] OpenCode did not become healthy within 45s.
	echo Bridge/UI will still be started, but chat/tooling may fail until OpenCode is ready.
) else (
	echo OpenCode is healthy.
)

echo [3/5] Starting bridge on port 8000...
start "TitanShift Bridge" cmd /k "cd /d ""%~dp0"" && npm --prefix bridge run dev"

echo [4/5] Starting UI on port 5173...
start "TitanShift UI" cmd /k "cd /d ""%~dp0"" && npm --prefix ui run dev -- --host 127.0.0.1"

echo [5/5] Opening browser...
start "" "http://127.0.0.1:5173"

echo.
echo TitanShift launch requested.
echo If a window shows a missing-tool error, install the dependency first:
echo - bun for opencode-upstream
echo - npm dependencies for bridge and ui
echo.
pause
