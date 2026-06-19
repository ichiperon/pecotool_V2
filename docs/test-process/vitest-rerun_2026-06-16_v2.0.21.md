# Vitest 再実行記録 — v2.0.21（2026-06-16）

> 現行 v2.0.21 のソースに対する Vitest（単体・結合）の再実行結果。
> 既存の [07-report.html](07-report.html)（2026-06-03 作成・対象 v2.0.7）は上書きしていない。
> この環境には Rust ツールチェインと Playwright browser が無いため、cargo test と E2E は対象外。

## 実行環境

- 日時: 2026-06-16 15:37（実行時間 75.76s）
- Node v24.16.0 / npm 11.13.0
- 依存: `npm ci` で 317 packages を新規インストール
- cargo: 無し（Rust テストは未実行）

## 実行コマンド

```
npm ci
npm run test
```

`npm run test` は `src/__tests__` の unit / components / integration を対象とする。重い実 PDF テストとソークテスト（`realPdf*` / `tjErrorRegression` / `loadTest500Pages` / `pdfMetadataLoaderReal` / `lruIdbRoundtrip` / `clipboardRoundtrip` / `undoRedoRoundtrip`）は除外する設定（package.json の `test` スクリプト）。

## 結果

| 区分 | 結果 |
|---|---|
| Test Files | 130 passed / 1 skipped（計 131） |
| Tests | 2088 passed / 3 skipped / 1 todo（計 2092） |
| 失敗 | 0 |
| Duration | 75.76s |

失敗ゼロ。現行 v2.0.21 のソースは Vitest（単体・結合）レベルで緑。

## この記録で確認していないもの（環境制約）

| 対象 | 未実行の理由 |
|---|---|
| cargo test（Rust・`src-tauri`） | この環境に Rust ツールチェイン（cargo）が無い |
| Playwright E2E | browser 未インストール（`playwright install` が別途必要） |
| `test:pdf:soak`（重い実 PDF / ソーク） | `npm run test` の対象外。実 PDF fixture が必要 |

完全な品質ゲート（`npm run test:quality` = build + critical + E2E + cargo test）の再実行には、Rust ツールチェインと Playwright browser の導入が前提。

## 既存テストプロセスとの関係

`docs/test-process/` の 01〜07 は 2026-06-03・対象 v2.0.7 で作成された一式（02〜04 は「v1.6.9 系」表記が残存し、内部でも版数表記が混在している）。本記録はそれらを置き換えるものではなく、v2.0.21 時点の Vitest 健全性を追補する。フルなテストプロセスの再実行は、環境を整えたうえで別途行う。
