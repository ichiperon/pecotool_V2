@echo off
setlocal
echo ========================================
echo PecoTool V2 - Enterprise Release Build System (Final)
echo ========================================

:: 1. Cleanup Old Artifacts
echo [1/5] Cleaning up old build artifacts...
if exist "dist-bin" (
    del /q "dist-bin\*.*"
) else (
    mkdir "dist-bin"
)

:: 2. Install dependencies
echo [2/5] Installing dependencies...
call npm install --silent
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    exit /b %errorlevel%
)

:: 3. Build Tauri App (EXE & MSI)
echo [3/5] Building Tauri application...
call npm run tauri build
if %errorlevel% neq 0 (
    echo [ERROR] Tauri build failed.
    exit /b %errorlevel%
)

:: 4. Collect Output
echo [4/5] Collecting new build artifacts...

:: EXEをコピー
echo Copying EXE installer...
if exist "src-tauri\target\release\bundle\nsis\*.exe" (
    copy "src-tauri\target\release\bundle\nsis\*.exe" "dist-bin\" /Y >nul
) else (
    echo [ERROR] EXE installer not found.
)

:: MANUALをコピー
echo Copying Manual...
copy "MANUAL.md" "dist-bin\README_MANUAL.md" /Y >nul

:: 5. Success
echo ========================================
echo BUILD SUCCESSFUL!
echo Output: dist-bin\
dir /b "dist-bin"
echo ========================================
echo さあ一味！今度こそ「dist-bin」フォルダの中を見なさい！
echo お宝がいっぱい詰まってるはずよ！
pause
