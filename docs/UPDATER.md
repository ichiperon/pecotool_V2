# Auto-Updater: Release & Key Generation Guide

Peco uses `tauri-plugin-updater` (Tauri 2.x) for automatic update notifications.

> **2026-06-10 更新（v2.0.15）**: 署名鍵を生成・設定し、updater を有効化した。
> - 秘密鍵: `C:\Users\user\.tauri\pecotool_v2.key`（バックアップ: リポジトリ直下 `keys/`・git 管理外）
> - 配布チャネル: **配布専用 public リポジトリ `abroadcrew02-spec/pecotool-releases`**（ソース本体は private のまま。本体 public 化は履歴に検証用 PDF・内部リンクが含まれるため不採用）
> - endpoint: `https://github.com/abroadcrew02-spec/pecotool-releases/releases/latest/download/latest.json`
> - **リリースは `scripts\release.ps1` で 1 コマンド化済み**（署名ビルド → latest.json 生成 → Release 公開 → dist-bin コピー）。以下の手動手順は仕組みの理解・トラブルシュート用として残す。
> - Tauri 2.x の Windows updater アーティファクトは `*-setup.exe` + `*-setup.exe.sig`（v1 時代の `.nsis.zip` 形式の記述は読み替えること）

## How it works

1. On startup, the app calls `check()` against the updater endpoint.
2. If a newer version is available, a toast notification appears with an "Update" action button.
3. The user can also manually trigger a check via **Help > Check for Updates**.
4. Clicking "Update" calls `downloadAndInstall()`, which downloads the installer and runs it passively.

## Release checklist

### 1. Generate a signing key pair (one-time setup)

```sh
# Install Tauri CLI if not already done
cargo install tauri-cli --version "^2"

# Generate the key pair
cargo tauri signer generate -w ~/.tauri/pecotool_v2.key
```

This outputs:
- `~/.tauri/pecotool_v2.key` — private key (keep secret, never commit)
- A public key string printed to stdout — copy this into `tauri.conf.json` under `plugins.updater.pubkey`

### 2. Update tauri.conf.json

Replace the `TODO` placeholder in `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "YOUR_BASE64_PUBLIC_KEY_HERE"
  }
}
```

### 3. Build and sign the release

```sh
# Set the private key path (or paste the key as an env var)
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/pecotool_v2.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<your-password-if-any>

cargo tauri build
```

The build produces a signed `.nsis` installer for Windows.

### 4. Create the latest.json update manifest

Tauri updater expects a JSON manifest at the endpoint URL configured in `tauri.conf.json`.
The file must be hosted at:

```
https://github.com/ichiperon/pecotool_V2/releases/latest/download/latest.json
```

Format:

```json
{
  "version": "2.x.y",
  "notes": "Release notes here",
  "pub_date": "2026-06-02T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/ichiperon/pecotool_V2/releases/download/v2.x.y/Peco_2.x.y_x64-setup.nsis.zip"
    }
  }
}
```

The `.sig` file is generated automatically by `cargo tauri build` when the signing key is set.

### 5. Publish the GitHub Release

1. Create a tag: `git tag v2.x.y && git push origin v2.x.y`
2. Draft a release on GitHub with the tag.
3. Attach the following artifacts:
   - `Peco_2.x.y_x64-setup.nsis.zip` (signed installer zip)
   - `Peco_2.x.y_x64-setup.nsis.zip.sig` (signature file)
   - `latest.json` (update manifest)
4. Publish the release.

## Upgrading from v2.0.7 or earlier (installer name change)

Starting from v2.0.8, the Windows installer is built with `productName: "Peco"`, so the
generated NSIS artifact name changed:

| Version | Installer filename |
| --- | --- |
| v2.0.7 and earlier | `pecotool-v2_2.x.y_x64-setup.nsis.zip` |
| v2.0.8 and later | `Peco_2.x.y_x64-setup.nsis.zip` |

**Impact for existing users upgrading from v2.0.7 or earlier:**

- The Tauri `identifier` (`com.ichip.pecotool-v2`) and `$APPDATA` path are **unchanged**, so
  user settings and data are preserved across the upgrade.
- NSIS treats the new installer as a distinct product name. Windows may show a separate
  entry in "Add or Remove Programs" for the old `pecotool-v2` install. Users should
  uninstall the old entry manually after upgrading, or the new installer's passive mode
  will overwrite the existing installation silently if the install path matches.
- The `latest.json` manifest hosted at the endpoint must use the new asset URL format
  (`Peco_2.x.y_x64-setup.nsis.zip`) for v2.0.8+ releases. The updater endpoint URL itself
  is unchanged.

## Development / test mode

During development the updater will fail silently (pubkey is a TODO placeholder, endpoint
may not exist). This is expected behavior — the error is caught in `useAppUpdater.ts` and
stored in `state.error` without crashing the app.

To test the full update flow locally, use a self-hosted update server or a local ngrok
tunnel pointed at a crafted `latest.json`.
