param(
    [switch]$Remote
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$distRepo = 'abroadcrew02-spec/pecotool-releases'
$mainTag = 'pecotool-updater'
$reportTag = 'report-tool-updater'
$mainAsset = 'latest.json'
$reportAsset = 'latest-report-tool.json'
$mainUrl = "https://github.com/$distRepo/releases/download/$mainTag/$mainAsset"
$reportUrl = "https://github.com/$distRepo/releases/download/$reportTag/$reportAsset"

function Assert-True([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}

function Assert-Throws([scriptblock]$action, [string]$message) {
    $threw = $false
    try { & $action } catch { $threw = $true }
    Assert-True $threw $message
}

function Get-FunctionExtent([string]$source, [string]$name) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $source,
        [ref]$tokens,
        [ref]$errors
    )
    Assert-True ($errors.Count -eq 0) "script parse failed while loading $name"
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $name
    }, $true)
    Assert-True ($null -ne $functionAst) "function not found: $name"
    return $functionAst.Extent.Text
}

function Test-VersionReleaseResumeValidator([string]$source, [bool]$expectedPrerelease) {
    Invoke-Expression (Get-FunctionExtent $source 'Assert-VersionReleaseForResume')
    $assets = @(
        [pscustomobject]@{ name = 'setup.exe'; state = 'uploaded'; size = 100 },
        [pscustomobject]@{ name = 'setup.exe.sig'; state = 'uploaded'; size = 10 },
        [pscustomobject]@{ name = 'latest.json'; state = 'uploaded'; size = 20 }
    )
    $expectedNames = @('setup.exe', 'setup.exe.sig', 'latest.json')
    $valid = [pscustomobject]@{ isPrerelease = $expectedPrerelease; assets = $assets }
    Assert-VersionReleaseForResume $valid $expectedPrerelease $expectedNames

    $wrongPrerelease = [pscustomobject]@{
        isPrerelease = -not $expectedPrerelease
        assets = $assets
    }
    Assert-Throws {
        Assert-VersionReleaseForResume $wrongPrerelease $expectedPrerelease $expectedNames
    } 'prerelease属性不一致を拒否しませんでした'

    $missingAsset = [pscustomobject]@{
        isPrerelease = $expectedPrerelease
        assets = @($assets | Select-Object -First 2)
    }
    Assert-Throws {
        Assert-VersionReleaseForResume $missingAsset $expectedPrerelease $expectedNames
    } '不足assetを拒否しませんでした'

    $emptyAsset = [pscustomobject]@{
        isPrerelease = $expectedPrerelease
        assets = @(
            [pscustomobject]@{ name = 'setup.exe'; state = 'uploaded'; size = 0 },
            $assets[1],
            $assets[2]
        )
    }
    Assert-Throws {
        Assert-VersionReleaseForResume $emptyAsset $expectedPrerelease $expectedNames
    } '空assetを拒否しませんでした'
}

function Test-ReportUpdaterPreflight([string]$source, [string]$expectedEndpoint) {
    Invoke-Expression (Get-FunctionExtent $source 'Assert-ReportUpdaterPreflight')
    $cargoPath = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content $cargoPath 'tauri-plugin-updater = "2"' -Encoding UTF8
        $valid = [pscustomobject]@{
            bundle = [pscustomobject]@{ createUpdaterArtifacts = $true }
            plugins = [pscustomobject]@{
                updater = [pscustomobject]@{
                    endpoints = @($expectedEndpoint)
                    pubkey = 'non-empty-public-key'
                }
            }
        }
        Assert-ReportUpdaterPreflight $valid $expectedEndpoint $cargoPath

        $missingArtifacts = [pscustomobject]@{
            bundle = [pscustomobject]@{ createUpdaterArtifacts = $false }
            plugins = $valid.plugins
        }
        Assert-Throws {
            Assert-ReportUpdaterPreflight $missingArtifacts $expectedEndpoint $cargoPath
        } 'createUpdaterArtifacts不足を拒否しませんでした'

        $wrongEndpoint = [pscustomobject]@{
            bundle = $valid.bundle
            plugins = [pscustomobject]@{
                updater = [pscustomobject]@{ endpoints = @('https://invalid.example'); pubkey = 'key' }
            }
        }
        Assert-Throws {
            Assert-ReportUpdaterPreflight $wrongEndpoint $expectedEndpoint $cargoPath
        } '固定endpoint不一致を拒否しませんでした'

        $blankPubkey = [pscustomobject]@{
            bundle = $valid.bundle
            plugins = [pscustomobject]@{
                updater = [pscustomobject]@{ endpoints = @($expectedEndpoint); pubkey = ' ' }
            }
        }
        Assert-Throws {
            Assert-ReportUpdaterPreflight $blankPubkey $expectedEndpoint $cargoPath
        } '空pubkeyを拒否しませんでした'

        Set-Content $cargoPath '[dependencies]' -Encoding UTF8
        Assert-Throws {
            Assert-ReportUpdaterPreflight $valid $expectedEndpoint $cargoPath
        } 'tauri-plugin-updater依存不足を拒否しませんでした'
    } finally {
        Remove-Item -LiteralPath $cargoPath -Force -ErrorAction SilentlyContinue
    }
}

$mainConfig = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$mainEndpoint = $mainConfig.plugins.updater.endpoints | Select-Object -First 1
Assert-True ($mainEndpoint -eq $mainUrl) '本体configが本体専用の固定updater channelを参照していません'
Assert-True ($mainTag -ne $reportTag) '本体と帳票のupdater tagが重複しています'
Assert-True ($mainAsset -ne $reportAsset) '本体と帳票のmanifest asset名が重複しています'

$mainScript = Get-Content (Join-Path $repoRoot 'scripts\release.ps1') -Raw
$reportScript = Get-Content (Join-Path $repoRoot 'scripts\release-report-tool.ps1') -Raw
Assert-True ($mainScript.Contains("`$CHANNEL_TAG = '$mainTag'")) '本体release scriptのchannel tagがconfigと不一致です'
Assert-True ($mainScript.Contains("`$CHANNEL_ASSET = '$mainAsset'")) '本体release scriptのmanifest名が不一致です'
Assert-True ($reportScript.Contains("`$CHANNEL_TAG = '$reportTag'")) '帳票release scriptのchannel tagが不一致です'
Assert-True ($reportScript.Contains("`$CHANNEL_ASSET = '$reportAsset'")) '帳票release scriptのmanifest名が不一致です'
Assert-True ($reportScript.Contains('--prerelease')) '帳票version releaseは旧本体のreleases/latestを保護する必要があります'
Assert-True ($mainScript.Contains("'release-channels.test.ps1') -Remote")) '本体release後の両channel smoke testがありません'
Assert-True ($reportScript.Contains("'release-channels.test.ps1') -Remote")) '帳票release後の両channel smoke testがありません'
Assert-True (-not $mainEndpoint.Contains('/releases/latest/')) '本体endpointにreleases/latestを使用できません'

# #462: 本体version release (gh release create $versionTag) がprereleaseだと、GitHubの
# repository全体で1つしかない releases/latest が本体version releaseを指さなくなり、
# 固定updater channel導入前にリリースされた旧クライアントの互換 (releases/latest 依存)
# が壊れる。version release作成呼び出しに --prerelease が含まれないことを静的検証する。
$versionReleaseCreateStart = $mainScript.IndexOf('gh release create $versionTag')
Assert-True ($versionReleaseCreateStart -ge 0) '本体version releaseのgh release create呼び出しが見つかりません'
$versionReleaseCreateEnd = $mainScript.IndexOf('gh release create $CHANNEL_TAG', $versionReleaseCreateStart)
Assert-True ($versionReleaseCreateEnd -gt $versionReleaseCreateStart) '本体updater channelのgh release create呼び出しが見つかりません'
$versionReleaseCreateBlock = $mainScript.Substring($versionReleaseCreateStart, $versionReleaseCreateEnd - $versionReleaseCreateStart)
Assert-True (-not $versionReleaseCreateBlock.Contains('--prerelease')) '本体version release(gh release create $versionTag)がprereleaseを含んでいます。releases/latestが本体を指さなくなり、旧クライアントのlegacy endpoint互換が壊れます'

foreach ($script in @($mainScript, $reportScript)) {
    Assert-True ($script.Contains('Get-VersionReleaseForResume')) '既存version releaseのresume判定がありません'
    Assert-True ($script.Contains('Assert-VersionReleaseForResume')) '既存version releaseの属性・資産検証がありません'
    Assert-True ($script.Contains('--json isPrerelease,assets')) 'resume判定がprerelease属性とassetsを取得していません'
    Assert-True ($script.Contains('Compare-Object $expectedNames $actualNames')) 'resume判定が資産名の完全一致を検証していません'
    Assert-True ($script.Contains('gh release download')) 'resume時に公開済み資産を再取得していません'
    Assert-True ($script.Contains('$resumePlatform.signature -ne $resumeSignature')) 'resume manifestと署名の一致検証がありません'
    Assert-True ($script.Contains('$resumePlatform.url -ne $assetUrl')) 'resume manifestとsetup URLの一致検証がありません'
}

$preflightCall = $reportScript.IndexOf('Assert-ReportUpdaterPreflight `')
$dependencyInstall = $reportScript.IndexOf("npm ci", $preflightCall)
Assert-True ($preflightCall -ge 0 -and $dependencyInstall -gt $preflightCall) '帳票updater preflightがnpm ci/buildより前に実行されていません'
Assert-True ($reportScript.Contains('$Config.bundle.createUpdaterArtifacts -ne $true')) 'createUpdaterArtifactsのpreflightがありません'
Assert-True ($reportScript.Contains('$configuredEndpoint -ne $ExpectedEndpoint')) '帳票固定endpointのpreflightがありません'
Assert-True ($reportScript.Contains('IsNullOrWhiteSpace([string]$Config.plugins.updater.pubkey)')) '帳票pubkeyのpreflightがありません'
Assert-True ($reportScript.Contains("tauri-plugin-updater\s*=")) 'tauri-plugin-updater依存のpreflightがありません'

Test-VersionReleaseResumeValidator $mainScript $false
Test-VersionReleaseResumeValidator $reportScript $true
Test-ReportUpdaterPreflight $reportScript $reportUrl

if ($Remote) {
    $cacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $main = Invoke-RestMethod -Uri "$mainUrl`?smoke=$cacheBust"
    $report = Invoke-RestMethod -Uri "$reportUrl`?smoke=$cacheBust"
    $mainPlatform = $main.platforms.'windows-x86_64'
    $reportPlatform = $report.platforms.'windows-x86_64'

    Assert-True ([bool]$main.version) '本体manifestにversionがありません'
    Assert-True ([bool]$mainPlatform.signature) '本体manifestにsignatureがありません'
    Assert-True ($mainPlatform.url.Contains('/releases/download/v')) '本体manifestが本体version releaseを参照していません'
    Assert-True ([bool]$report.version) '帳票manifestにversionがありません'
    Assert-True ([bool]$reportPlatform.signature) '帳票manifestにsignatureがありません'
    Assert-True ($reportPlatform.url.Contains('/releases/download/report-v')) '帳票manifestが帳票version releaseを参照していません'

    # #462: 固定updater channel導入前の旧クライアントは repository 全体の
    # releases/latest を参照し続ける。この生命線 (legacy endpoint) が生きているか、
    # 固定channelと同じversionを返すかを追加でスモーク検証する。
    $legacyUrl = "https://github.com/$distRepo/releases/latest/download/$mainAsset"
    $legacyResponse = Invoke-WebRequest -Uri "$legacyUrl`?smoke=$cacheBust" -UseBasicParsing
    Assert-True ($legacyResponse.StatusCode -eq 200) "legacy releases/latest endpointがHTTP 200を返しませんでした: $legacyUrl"
    $legacy = $legacyResponse.Content | ConvertFrom-Json
    Assert-True ([bool]$legacy.version) 'legacy releases/latest endpointのmanifestにversionがありません'
    Assert-True ($legacy.version -eq $main.version) "legacy releases/latest endpointのversionが固定channelと不整合です (legacy=$($legacy.version), channel=$($main.version))"
}

Write-Host 'release channel verification passed'
