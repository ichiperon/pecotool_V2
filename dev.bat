@echo off
setlocal
echo ========================================
echo PecoTool V2 - Dev Launch
echo ========================================

:: Install dependencies if needed
if not exist "node_modules" (
    echo [1/2] Installing npm dependencies...
    call npm install --silent
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b %errorlevel%
    )
) else (
    echo [1/2] Dependencies OK
)

:: Launch Tauri dev mode
echo [2/2] Starting PecoTool V2...
call npm run tauri dev
if %errorlevel% neq 0 (
    echo [ERROR] Failed to start.
    pause
    exit /b %errorlevel%
)
