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

function Get-VersionReleaseForResume([string]$Tag, [string]$Repository) {
    $json = gh release view $Tag --repo $Repository --json isPrerelease,assets 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $json | ConvertFrom-Json
}

function Assert-VersionReleaseForResume(
    [object]$Release,
    [bool]$ExpectedPrerelease,
    [string[]]$ExpectedAssetNames
) {
    if ([bool]$Release.isPrerelease -ne $ExpectedPrerelease) {
        throw "既存version releaseのprerelease属性が不一致です"
    }
    $actualNames = @($Release.assets | ForEach-Object { $_.name } | Sort-Object)
    $expectedNames = @($ExpectedAssetNames | Sort-Object)
    if (@(Compare-Object $expectedNames $actualNames).Count -ne 0) {
        throw "既存version releaseの資産が不一致です: expected=$($expectedNames -join ',') actual=$($actualNames -join ',')"
    }
    foreach ($asset in $Release.assets) {
        if ($asset.state -ne 'uploaded' -or [long]$asset.size -le 0) {
            throw "既存version releaseに未完了または空の資産があります: $($asset.name)"
        }
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$DIST_REPO = 'abroadcrew02-spec/pecotool-releases'
$CHANNEL_TAG = 'pecotool-updater'
$CHANNEL_ASSET = 'latest.json'
$CHANNEL_URL = "https://github.com/$DIST_REPO/releases/download/$CHANNEL_TAG/$CHANNEL_ASSET"

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
$configuredEndpoint = $conf.plugins.updater.endpoints | Select-Object -First 1
if ($configuredEndpoint -ne $CHANNEL_URL) {
    Write-Error "updater endpoint と配布チャネルが不一致です: config=$configuredEndpoint expected=$CHANNEL_URL"
}
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
$versionTag = "v$version"
$expectedAssets = @($setupExe.Name, $sigFile.Name, $CHANNEL_ASSET)
$existingVersionRelease = Get-VersionReleaseForResume $versionTag $DIST_REPO
if ($existingVersionRelease) {
    Assert-VersionReleaseForResume $existingVersionRelease $false $expectedAssets
    # 前回version release作成後にchannel更新だけ失敗したケース。再buildしたローカル
    # 成果物ではなく、公開済み3資産を再取得して同一manifestから安全に再開する。
    gh release download $versionTag `
        --repo $DIST_REPO `
        --dir $bundleDir `
        --clobber `
        --pattern $setupExe.Name `
        --pattern $sigFile.Name `
        --pattern $CHANNEL_ASSET
    if ($LASTEXITCODE -ne 0) { Write-Error '既存version release資産の取得に失敗しました' }

    $resumeManifest = Get-Content $latestPath -Raw | ConvertFrom-Json
    $resumePlatform = $resumeManifest.platforms.'windows-x86_64'
    $resumeSignature = (Get-Content $sigFile.FullName -Raw).Trim()
    if ($resumeManifest.version -ne $version -or
        $resumePlatform.signature -ne $resumeSignature -or
        $resumePlatform.url -ne $assetUrl) {
        Write-Error '既存version releaseのmanifest/signature/setup URLが不整合です'
    }
    Write-Host "[6/7] 既存 Release $versionTag を検証済み。channel phaseから再開します"
} else {
    Write-Host "[6/7] $DIST_REPO に Release $versionTag を公開..."
    gh release create $versionTag `
        --repo $DIST_REPO `
        --title "Peco v$version" `
        --notes "Peco v$version — 更新内容はアプリ配布元の案内を参照してください。" `
        $setupExe.FullName $sigFile.FullName $latestPath
    if ($LASTEXITCODE -ne 0) { Write-Error 'gh release create が失敗しました' }
}

# repository 全体で1つしかない releases/latest を更新チャネルに使わず、
# 本体専用の固定tagへmanifestだけをclobber更新する。channel release自体は
# prereleaseにして、旧版が参照する releases/latest も本体version releaseのまま保つ。
$channelRelease = $null
gh release view $CHANNEL_TAG --repo $DIST_REPO --json isPrerelease 2>$null | ForEach-Object {
    $channelRelease = $_ | ConvertFrom-Json
}
if (-not $channelRelease) {
    gh release create $CHANNEL_TAG `
        --repo $DIST_REPO `
        --title 'Peco updater channel' `
        --notes 'Peco本体専用の固定updater manifest。version releaseとは独立して更新されます。' `
        --prerelease
    if ($LASTEXITCODE -ne 0) { Write-Error '本体updater channelの作成に失敗しました' }
} elseif (-not $channelRelease.isPrerelease) {
    Write-Error "$CHANNEL_TAG は prerelease である必要があります（releases/latestを奪わないため）"
}
gh release upload $CHANNEL_TAG --repo $DIST_REPO --clobber $latestPath
if ($LASTEXITCODE -ne 0) { Write-Error '本体updater manifestの公開に失敗しました' }

$published = Invoke-RestMethod -Uri "$CHANNEL_URL`?version=$version"
if ($published.version -ne $version -or
    -not $published.platforms.'windows-x86_64'.signature -or
    $published.platforms.'windows-x86_64'.url -ne $assetUrl) {
    Write-Error "本体updater channelの公開後検証に失敗しました: $CHANNEL_URL"
}

# 帳票channelが既に存在する運用開始後は、交互リリースのたびに両endpointを検証する。
gh release view 'report-tool-updater' --repo $DIST_REPO 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    & (Join-Path $PSScriptRoot 'release-channels.test.ps1') -Remote
}

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
Write-Host "Updater: $CHANNEL_URL"
Write-Host "既存ユーザーのアプリは次回起動時に自動で更新を検知します。"
