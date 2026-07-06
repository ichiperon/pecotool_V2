# capabilities/default.json 設計メモ

## fs scope が指すもの（PCT-107 / #330 残余対応）

`default.json` の `fs:allow-*` の `allow` scope（`$DESKTOP/**` `$DOCUMENT/**`
`$DOWNLOAD/**` `$TEMP/**`）は、**JS 側 `@tauri-apps/plugin-fs` 経由の
ファイルアクセス**（ユーザーがダイアログで選んだ PDF の read/write、および
Rust 側 `validate_allowed_resolved_path` によるユーザー選択パスの検証）だけを
対象にした最終防壁である。

以前 `$APPDATA/pecotool/**` `$APPCONFIG/pecotool/**` `$APPLOCALDATA/pecotool/**`
を scope に含めていたが、以下の理由でいずれも実効性がなく削除した:

- JS 側で `appDataDir()` / `appLocalDataDir()` / `appConfigDir()` を使う箇所が
  存在しない（`src/` 配下に import 自体が無い）。
- Rust 側のバックアップ・ログ・監査ログ書込み（`backup.rs` の
  `app_data_dir()/backups/`、`lib.rs` の `app_local_data_dir()/perf/` `/logs/`
  `/audit/` など）はいずれも **`std::fs` を直接呼んでおり、fs plugin の
  scope チェックを経由しない**。したがって scope に何を書いても、これらの
  書込み処理には一切影響しない（許可しても防御にならない／制限しても
  ブロックされない）。
- 実際にパス文字列は `pecotool/` サブディレクトリを含んでいたが、
  `app_data_dir()` / `app_local_data_dir()` の解決結果（identifier 付き
  ディレクトリ直下）とはそもそも一致しておらず、scope 文字列と実書込み先が
  乖離した状態だった（severity: 実害なしのため low、#330 参照）。

## 設計上の結論

- **fs plugin の scope は JS 起点のファイル I/O にのみ効く多層防御**であり、
  Rust コマンド内の `std::fs` 直書きには及ばない。
- Rust 側の書込み先を安全に保つ責務は、各コマンド内のパス検証・
  ファイル名サニタイズ（例: `perf`/`logs` の ASCII 英数字 + `-`/`_` 限定）
  が担っており、scope はその代替にはならない。
- 将来 backup/log/audit 系を `tauri_plugin_fs::FsExt` 経由の API に寄せる場合は、
  その時点で実際の書込み先ディレクトリを実機確認のうえ scope に追加すること。
  それまでは「scope に含める＝防御になる」という誤解を避けるため、
  未使用パスは capability に含めない。

関連: [#330 (PCT-107)](https://github.com/ichiperon/pecotool_V2/issues/330) —
fs scope 文字列と実書込み先の不一致。`tauriCapabilityIntegrity.test.ts` は
JS 側 import と capability の整合のみを検証するため、本メモの対象
（Rust std::fs 直書き）はテスト範囲外。
