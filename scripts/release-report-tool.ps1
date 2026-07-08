# PecoReportTool（帳票ツール）リリーススクリプト — ドラフト（実機未検証）
#
# 署名付きビルド → latest-report-tool.json 生成 → 配布リポジトリ (pecotool-releases)
# への GitHub Release 公開までを 1 コマンドで行う。本体 release.ps1 の実測済み
# パターンを踏襲（Tauri v2 は TAURI_SIGNING_PRIVATE_KEY に「鍵の中身」を渡す）。
#
# 本体との分離（計画書 §5.2/§5.3・不変条件D/F）:
#   - updater 署名鍵はアプリ別: peco_report_tool.key（本体 pecotool_v2.key と共用禁止。
#     同一鍵だと本体 updater が帳票ツールの .sig を誤検証する）
#   - updater JSON も別: latest-report-tool.json（本体の latest.json には一切触れない）
#   - リリースタグも別系統: report-v0.x.x（本体 v2.x.x と衝突しない）
#
# ⚠ 初回リリース前の前提（未完了なら本スクリプトは前提チェックで停止する）:
#   1. 鍵生成（OPS 判断・ユーザー実行）:
#        npx tauri signer generate -w "$HOME\.tauri\peco_report_tool.key"
#   2. apps/report-tool/src-tauri/tauri.conf.json に updater 設定を追加:
#        bundle.createUpdaterArtifacts: true
#        plugins.updater.pubkey: <上記で生成した公開鍵>
#        plugins.updater.endpoints: [ ".../latest-report-tool.json" ]
#      （これが無いと .sig が生成されず [4/7] で停止する）
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\release-report-tool.ps1
#   （バージョンは apps/report-tool/src-tauri/tauri.conf.json から自動取得）

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$DIST_REPO = 'abroadcrew02-spec/pecotool-releases'
$APP_DIR = Join-Path $repoRoot 'apps\report-tool'

# --- 1. 前提チェック -------------------------------------------------------
$keyCandidates = @("$HOME\.tauri\peco_report_tool.key", (Join-Path $repoRoot 'keys\peco_report_tool.key'))
$keyPath = $keyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $keyPath) {
    Write-Error ("帳票ツール用の署名秘密鍵が見つかりません: $($keyCandidates -join ' / ')`n" +
        "本体鍵 (pecotool_v2.key) の流用は禁止（本体 updater の誤検証を招く）。`n" +
        "生成: npx tauri signer generate -w `"$HOME\.tauri\peco_report_tool.key`"")
}
Write-Host "[1/7] 署名鍵: $keyPath"

gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'gh CLI が未認証です (gh auth login)' }

$conf = Get-Content (Join-Path $APP_DIR 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $version) { Write-Error 'tauri.conf.json から version を取得できません' }
$tag = "report-v$version"
Write-Host "[1/7] バージョン: $version (タグ: $tag)"

# タグ重複の早期検出（既存 Release を上書きしない）
gh release view $tag --repo $DIST_REPO 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Error "Release $tag は既に $DIST_REPO に存在します" }

# --- 2. 依存関係インストール -------------------------------------------------
# npm workspaces のためルートで npm ci（apps/report-tool の依存も入る）
Write-Host '[2/7] npm ci を実行 (ルート・workspaces)...'
npm ci
if ($LASTEXITCODE -ne 0) { Write-Error 'npm ci が失敗しました' }

# --- 3. 署名付きビルド -----------------------------------------------------
Write-Host '[3/7] 署名付きビルドを実行 (数分〜15分)...'
# Tauri v2 の build は TAURI_SIGNING_PRIVATE_KEY (鍵の中身) のみを参照する
# (_PATH 変数は読まれない — 本体 v2.0.15 リリース時に実測確認済み)。
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
# フロントのみ変更でも Rust 再リンクさせる（古いフロント焼き込み防止・実測済みの罠）
(Get-Item (Join-Path $APP_DIR 'src-tauri\src\main.rs')).LastWriteTime = Get-Date
Push-Location $APP_DIR
try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { Write-Error 'tauri build が失敗しました' }
} finally {
    Pop-Location
}

# --- 4. 成果物の確認 -------------------------------------------------------
$bundleDir = Join-Path $APP_DIR 'src-tauri\target\release\bundle\nsis'
$setupExe = Get-ChildItem $bundleDir -Filter "*_${version}_x64-setup.exe" | Select-Object -First 1
if (-not $setupExe) { Write-Error "インストーラが見つかりません: $bundleDir" }
$sigFile = Get-ChildItem $bundleDir -Filter "$($setupExe.Name).sig" | Select-Object -First 1
if (-not $sigFile) {
    Write-Error ".sig が見つかりません。tauri.conf.json の bundle.createUpdaterArtifacts と updater 設定（ヘッダの前提2）を確認してください"
}
Write-Host "[4/7] 成果物: $($setupExe.Name) + .sig"

# --- 5. latest-report-tool.json 生成 ---------------------------------------
$signature = (Get-Content $sigFile.FullName -Raw).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$assetUrl = "https://github.com/$DIST_REPO/releases/download/$tag/$($setupExe.Name)"
$latest = [ordered]@{
    version  = $version
    notes    = "PecoReportTool v$version"
    pub_date = $pubDate
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $assetUrl
        }
    }
}
$latestPath = Join-Path $bundleDir 'latest-report-tool.json'
$latest | ConvertTo-Json -Depth 5 | Set-Content $latestPath -Encoding UTF8
Write-Host "[5/7] latest-report-tool.json 生成: $latestPath"

# --- 6. GitHub Release 公開 (配布リポジトリ) -------------------------------
Write-Host "[6/7] $DIST_REPO に Release $tag を公開..."
gh release create $tag `
    --repo $DIST_REPO `
    --title "PecoReportTool v$version" `
    --notes "PecoReportTool v$version — 帳票OCR/CSVツール。本体 Peco とは独立に更新されます。" `
    $setupExe.FullName $sigFile.FullName $latestPath
if ($LASTEXITCODE -ne 0) { Write-Error 'gh release create が失敗しました' }

# --- 7. dist-bin へコピー --------------------------------------------------
$distBin = Join-Path $repoRoot 'dist-bin'
if (-not (Test-Path $distBin)) { New-Item -ItemType Directory $distBin | Out-Null }
Copy-Item $setupExe.FullName $distBin -Force
Write-Host "[7/7] dist-bin へコピー完了"

Write-Host ''
Write-Host "=== 帳票ツール リリース完了: $tag ==="
Write-Host "Release: https://github.com/$DIST_REPO/releases/tag/$tag"
Write-Host "※ 本体の latest.json には触れていません（不変条件F）"
