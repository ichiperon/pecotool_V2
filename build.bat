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

:: EXEをコピー (実行ファイル名が tauri-app.exe になってるみたいね！)
echo Copying EXE executable...
if exist "src-tauri\target\release\tauri-app.exe" (
    copy "src-tauri\target\release\tauri-app.exe" "dist-bin\pecotool-v2.exe" /Y >nul
) else if exist "src-tauri\target\release\pecotool-v2.exe" (
    copy "src-tauri\target\release\pecotool-v2.exe" "dist-bin\pecotool-v2.exe" /Y >nul
) else (
    echo [ERROR] EXE file not found in release directory.
)

:: MSIをコピー
echo Copying MSI installer...
copy "src-tauri\target\release\bundle\msi\*.msi" "dist-bin\" /Y >nul
if %errorlevel% neq 0 (
    echo [WARNING] MSI file not found or copy failed.
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
