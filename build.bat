@echo off
setlocal
echo ========================================
echo PecoTool V2 - Build Script
echo ========================================

:: 1. Install dependencies
echo [1/3] Installing dependencies...
call npm install --silent
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    exit /b %errorlevel%
)

:: 2. Build Tauri App
echo [2/3] Building Tauri application...
call npm run tauri build
if %errorlevel% neq 0 (
    echo [ERROR] Tauri build failed.
    exit /b %errorlevel%
)

:: 3. Collect Output
echo [3/3] Collecting build artifacts...
if not exist "dist-bin" mkdir "dist-bin"
copy "src-tauri\target\release\pecotool-v2.exe" "dist-bin\" /Y
if %errorlevel% neq 0 (
    echo [ERROR] Failed to copy the executable.
    exit /b %errorlevel%
)

echo ========================================
echo BUILD SUCCESSFUL!
echo Output: dist-bin\pecotool-v2.exe
echo ========================================
pause
