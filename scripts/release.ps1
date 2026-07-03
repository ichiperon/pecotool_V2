# PecoTool v2 リリーススクリプト
#
# 署名付きビルド → latest.json 生成 → 配布リポジトリ (pecotool-releases) への
# GitHub Release 公開までを 1 コマンドで行う。
#
# 前提:
#   - 署名秘密鍵: $HOME\.tauri\pecotool_v2.key (または keys\pecotool_v2.key)
#   - gh CLI が認証済み (gh auth status)
#   - 依存関係のインストールはこのスクリプトが npm ci で自動実行する
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   （バージョンは tauri.conf.json から自動取得）

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$DIST_REPO = 'abroadcrew02-spec/pecotool-releases'

# --- 1. 前提チェック -------------------------------------------------------
$keyCandidates = @("$HOME\.tauri\pecotool_v2.key", (Join-Path $repoRoot 'keys\pecotool_v2.key'))
$keyPath = $keyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $keyPath) {
    Write-Error "署名秘密鍵が見つかりません: $($keyCandidates -join ' / ')"
}
Write-Host "[1/7] 署名鍵: $keyPath"

gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'gh CLI が未認証です (gh auth login)' }

$conf = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $version) { Write-Error 'tauri.conf.json から version を取得できません' }
Write-Host "[1/7] バージョン: $version"

# --- 2. 依存関係インストール -------------------------------------------------
Write-Host '[2/7] npm ci を実行...'
npm ci
if ($LASTEXITCODE -ne 0) { Write-Error 'npm ci が失敗しました' }

# --- 3. 署名付きビルド -----------------------------------------------------
Write-Host '[3/7] 署名付きビルドを実行 (数分〜15分)...'
# Tauri v2 の build は TAURI_SIGNING_PRIVATE_KEY (鍵の中身) のみを参照する。
# _PATH 変数は signer generate のヘルプに載っているが build では読まれない
# (v2.0.15 リリース時に実測確認)。
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npm run tauri build
if ($LASTEXITCODE -ne 0) { Write-Error 'tauri build が失敗しました' }

# --- 4. 成果物の確認 -------------------------------------------------------
$bundleDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$setupExe = Get-ChildItem $bundleDir -Filter "*_${version}_x64-setup.exe" | Select-Object -First 1
if (-not $setupExe) { Write-Error "インストーラが見つかりません: $bundleDir" }
$sigFile = Get-ChildItem $bundleDir -Filter "$($setupExe.Name).sig" | Select-Object -First 1
if (-not $sigFile) {
    Write-Error "署名ファイル (.sig) が見つかりません。TAURI_SIGNING_PRIVATE_KEY 環境変数（鍵の中身）が設定されているか確認してください"
}
Write-Host "[4/7] 成果物: $($setupExe.Name) + .sig"

# --- 5. latest.json 生成 ---------------------------------------------------
$signature = (Get-Content $sigFile.FullName -Raw).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$assetUrl = "https://github.com/$DIST_REPO/releases/download/v$version/$($setupExe.Name)"
$latest = [ordered]@{
    version  = $version
    notes    = "Peco v$version"
    pub_date = $pubDate
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $assetUrl
        }
    }
}
$latestPath = Join-Path $bundleDir 'latest.json'
$latest | ConvertTo-Json -Depth 5 | Set-Content $latestPath -Encoding UTF8
Write-Host "[5/7] latest.json 生成: $latestPath"

# --- 6. GitHub Release 公開 (配布リポジトリ) -------------------------------
Write-Host "[6/7] $DIST_REPO に Release v$version を公開..."
gh release create "v$version" `
    --repo $DIST_REPO `
    --title "Peco v$version" `
    --notes "Peco v$version — 更新内容はアプリ配布元の案内を参照してください。" `
    $setupExe.FullName $sigFile.FullName $latestPath
if ($LASTEXITCODE -ne 0) { Write-Error 'gh release create が失敗しました' }

# --- 7. dist-bin へコピー --------------------------------------------------
$distBin = Join-Path $repoRoot 'dist-bin'
if (-not (Test-Path $distBin)) { New-Item -ItemType Directory $distBin | Out-Null }
Copy-Item $setupExe.FullName $distBin -Force
if (Test-Path (Join-Path $repoRoot 'docs\MANUAL.md')) {
    Copy-Item (Join-Path $repoRoot 'docs\MANUAL.md') (Join-Path $distBin 'README_MANUAL.md') -Force
}
Write-Host "[7/7] dist-bin へコピー完了"

Write-Host ''
Write-Host "=== リリース完了: v$version ==="
Write-Host "Release: https://github.com/$DIST_REPO/releases/tag/v$version"
Write-Host "既存ユーザーのアプリは次回起動時に自動で更新を検知します。"
