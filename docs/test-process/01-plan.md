# PecoTool v2 テスト計画書

> **作成日**: 2026-06-03
> **作成者**: PM (桐生ココ / product_manager)
> **バージョン**: v2.0.7
> **現在のテスト通過数**: vitest 1647/1649、Playwright e2e 52/52

---

## 1. 目的

本計画書は PecoTool v2（OCR テキストレイヤー編集ツール）の品質保証プロセスを定義する。

### 保証の対象

- PDF テキストレイヤーの編集・保存処理の正確性（データロスがないこと）
- 保存後 PDF の Acrobat 互換性（dirty flag 不発火・BT...ET 構文正常）
- ユーザー操作ループの安定性（Undo/Redo・選択・ドラッグ）
- 大規模 PDF（1000 ページ超）でのメモリ・パフォーマンス許容範囲

### 保証しないこと（スコープ外）

- OCR エンジン（PaddleOCR）の認識精度
- PDF/A・PDF/UA 準拠性
- Acrobat 以外の PDF ビューア（Foxit・Sumatra 等）との完全互換
- 圧縮保存 UI（SaveDialog の rasterize パス）——未接続につき対象外
- macOS・Linux 上での動作（Windows 11 のみ保証対象）

---

## 2. 対象スコープ

### 本リリース（v2.0.7）で保証する範囲

| 機能カテゴリ | 保証範囲 |
|---|---|
| PDF 読み込み・表示 | pdfjs-dist 5.5 + WebWorker による描画、LRU キャッシュ（50 ページ） |
| OCR テキスト編集 | TextBlock の text/bbox/writingMode/order の編集、Undo/Redo（上限 100） |
| BB 操作 | グループ化・分割・追加・削除・重複削除・Alt+ドラッグ序列修正 |
| PDF 保存 | 上書き保存（Ctrl+S）・名前を付けて保存（Ctrl+Shift+S）、no-op short-circuit |
| Acrobat 互換 | trailer /ID 保持、BT...ET 構文、旧/新形式 PecoTool メタ混在 |
| バックアップ | 5 分間隔自動バックアップ、クラッシュリカバリダイアログ |
| UI 操作 | Ribbon ショートカット、Ctrl+F 検索、サムネイル仮想スクロール |
| パフォーマンス | 1000 ページ PDF で 3 秒以内初期表示・200ms 以内ページ遷移・500 MB 未満メモリ |

### 本リリースで保証しない範囲

- 圧縮保存・ラスタライズ保存（SaveDialog UI は存在するが非接続）
- Tauri 自動更新（sidecar / GitHub Releases 連携）
- Acrobat 7.0 dirty flag 完全解消（Layer 2 原因: CIDFontType0 /CIDToGIDMap・Contents 配列 wrapper は次回調査）

---

## 3. リスク抽出

### Critical — データロス・クラッシュ・ブロッカー

| # | リスク | 根拠 / 発生シナリオ |
|---|---|---|
| C-01 | PDF 保存中の部分書き込みによるファイル破損 | 一時ファイル → リネーム方式だが、Tauri sidecar クラッシュで temp が残留する可能性 |
| C-02 | savePDF の no-op short-circuit が誤判定し、編集済みデータを無視して元バイトを返す | `dirtyPages.length === 0` の判定が LRU 退避済みページを考慮しない場合に発生しうる |
| C-03 | LRU 退避時の IDB 書き込み失敗による編集データ消失 | `saveTemporaryPageDataBatch` の IndexedDB write エラーが silent fail する経路 |
| C-04 | saveDuringEditRace: 保存中にページ編集で state が分岐 | `saveDuringEditRace.test.ts` で検出済みシナリオ、regression 防止が必要 |
| C-05 | BT...ET ブロックが閉じられないまま保存され PDF 構造が破壊 | `pdfSaverCurveGlyph.test.ts` で対処済みだが、新フォントパスで再発リスク |

### High — 顕著なユーザー体験劣化

| # | リスク | 根拠 / 発生シナリオ |
|---|---|---|
| H-01 | 保存後の Acrobat dirty flag（「保存しますか？」ダイアログ） | `issue_acrobat_save_prompt.md` 記載の Layer 2 原因（CIDFontType0 /CIDToGIDMap・Contents 配列 wrapper）が未解決 |
| H-02 | Acrobat 7.0 実機での BT...ET エラー | `pdfSaver.acrobat7compat.test.ts` は通過しているが実機未検証（`issue_acrobat_save_prompt.md` §Acrobat実機確認メモ） |
| H-03 | OCR 結果のテキストが保存後 PDF でコピペしたときに読み順がずれる | Content Stream 内のテキストオブジェクト順序が `order` フィールドと不一致の場合に発生 |
| H-04 | 縦書き OCR の baselineY 計算ミスによる文字位置ズレ | `pdfSaverRotateOcr.test.ts` で検出済み、フォールバックフォント使用時に再発リスク |
| H-05 | バックアップ復元失敗（`check_pending_backups` / BackupRestoreDialog） | Tauri コマンド経路のテストが手動のみ、自動化なし |
| H-06 | 編集途中の保存でフリーズ（保存 Worker が応答しない場合） | `pdfSaver.ts` Worker postMessage 後のタイムアウト機構がない |
| H-07 | 旧形式 PecoTool メタ（`/Info/PecoToolBBoxes`）を含む PDF で新保存後にデータが消える | `pdfSaverNonDirtyMetaPreservation.test.ts` で保護済みだが migration パスの網羅が不完全 |

### Medium — 気付くが致命的でない

| # | リスク | 根拠 / 発生シナリオ |
|---|---|---|
| M-01 | Ribbon ショートカット（Alt キーアクセラレータ）の一部が効かない | Phase 4 実装直後、既存ショートカットとの干渉が未検証 |
| M-02 | ResizeObserver Ribbon 折りたたみで一部ボタンが消える | Phase 3 実装、極端に狭いウィンドウ幅での回帰 |
| M-03 | 1000 ページ PDF でのサムネイル仮想スクロール遅延 | `loadTest500Pages.test.ts` は 500 ページ、1000 ページは E2E スモークテストのみ |
| M-04 | `fontBytes` の ArrayBuffer transfer による保存後フォント喪失 | `HANDOVER.md` 記載の既知バグ、連続保存で発現 |
| M-05 | a11y: キーボードのみで全操作が完結しない箇所（canvas ドラッグ等） | 未計測、`requirements.md` §3.4 でマニュアルなし操作を謳っている |
| M-06 | 検索フィルタ中のドラッグ無効化が効かずに order が壊れる | `findReplaceSkipEditing.test.tsx` で保護済みだが UI 挙動変更時に再発リスク |

### Low — ポリッシュ・エッジケース

| # | リスク | 根拠 / 発生シナリオ |
|---|---|---|
| L-01 | 高ズームでの Canvas 描画崩れ（500% 以上） | 受入条件外だが UX 劣化 |
| L-02 | 保存完了トーストのファイルサイズ表示が 0B になる | `format.ts` の 0 bytes 処理は正常だが Tauri write 結果取得の非同期タイミング依存 |
| L-03 | 最近使ったファイル（sessionStorage）が F5 リロード後に消える | 仕様どおりだが初見ユーザーが混乱する可能性 |
| L-04 | pdfjs Worker の `document.createElement` polyfill 抜け | `MEMORY.md` 記載、thumbnail.worker.ts 等での render() 前に必須 |

---

## 4. テストアプローチ

### テスト階層（Tier 構成）

```
Tier 3: 手動確認（Acrobat 実機）
  └─ Acrobat 7.0 / 現行 Acrobat Reader・Pro での A/B テスト
     本番デプロイ前に必須。自動化不可。

Tier 2: Playwright E2E（52 テスト）
  └─ Tauri mock 経由。実アプリ UI を操作するスモークテスト。
     npm run test:e2e:ci

Tier 1: Vitest（1647/1649 通過）
  ├─ Acceptance gate: npm run test:pdf:acceptance（79 ケース）
  ├─ State acceptance: npm run test:state:acceptance（35 ケース）
  ├─ Unit: src/__tests__/unit/（純粋ロジック）
  ├─ Component: src/__tests__/components/（RTL）
  └─ Integration: src/__tests__/integration/（クロスモジュール）
```

### Tier 1 詳細

| スクリプト | 含まれるテスト群 | 目的 |
|---|---|---|
| `npm run test` | unit + components + integration（soak 除外） | 通常開発サイクル |
| `npm run test:pdf:acceptance` | pdfSaver 系 acceptance（9 ファイル） | PDF 保存・Acrobat 互換の acceptance gate |
| `npm run test:state:acceptance` | saveDuringEditRace + usePageNavigation + useBlockDragResize + useFileOperations | 状態管理 acceptance gate |
| `npm run test:critical` | acceptance + state acceptance | デプロイ前必須チェック |
| `npm run test:pdf:soak` | realPdf* + tjError + loadTest + IDB roundtrip | 重いテスト（CI 除外、開発者手動） |

### モック戦略（既定）

| 対象 | 方式 |
|---|---|
| Tauri API (`@tauri-apps/api/*`) | `vi.mock` でスタブ |
| pdfjs-dist Worker | `vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', ...)` |
| Canvas 2D Context | `setup.ts` での minimal stub |
| IndexedDB | `fake-indexeddb` または `vi.mock` |
| Tauri updater | `src/__tests__/__stubs__/tauri-plugin-updater.ts` |

### 回帰防止プロセス

- `test:critical` を PR マージ前の必須ゲートとして実行
- `test:pdf:soak` を週次または重大変更時に手動実行
- Playwright E2E を dev server 起動後（`npm run tauri dev`）に実行
- 新しい PDF 保存パスを追加する際は `savePdfAcceptanceStrict.test.ts` にケースを追加

---

## 5. テスト環境

### 開発環境（自動テスト実行）

| 項目 | 値 |
|---|---|
| OS | Windows 11 Pro (10.0.22631) |
| Node | 22.x |
| Package manager | npm |
| Tauri | 2.x |
| WebView2 | システム既定（Chromium ベース） |
| テストフレームワーク | Vitest 4.1、Playwright 1.59 |
| DOM 環境 | jsdom 29 |

### CI 環境

現時点で専用 CI パイプラインなし。`npm run test:ci`（= `test:quality`）を手動実行でカバー。

### 実機検証環境（Tier 3）

| 対象 | 状況 | 担当 |
|---|---|---|
| Adobe Acrobat 7.0 Professional | ローカル環境にインストール済み | ユーザー手動 |
| Adobe Acrobat Reader（現行版） | 要確認 | ユーザー手動 |
| Adobe Acrobat Pro（現行版） | 要確認 | ユーザー手動 |

> **制約**: Acrobat 実機検証は Claude 実行環境から不可。dirty flag 確認・BT...ET 目視確認はユーザー手動必須。

---

## 6. 進入基準・退出基準

### 進入基準（テストフェーズ開始条件）

- [ ] `tsc --noEmit` がエラーゼロで完了する
- [ ] `eslint` がエラーゼロで完了する（warning は許容）
- [ ] `npm run test` が全件通過する（`--exclude soak` 条件で）

### 退出基準（リリース可能条件）

| 基準 | 目標値 | 現在値 |
|---|---|---|
| vitest 総通過数 | 1647 以上 | 1647/1649 |
| `test:pdf:acceptance` | 全件 pass | 79 件対象 |
| Playwright E2E | 52 以上 pass | 52/52 |
| Critical リスク未解決件数 | 0 | 要確認（C-01〜C-05） |
| High リスク未解決件数（Acrobat 互換除く） | 0 | 要確認（H-03〜H-07） |
| High リスク Acrobat 互換（H-01・H-02） | 実機確認済み or 次版送り合意 | 未実施 |
| `npm run test:tauri`（Rust cargo test） | 全件 pass | 未計測 |

> **注**: H-01（Acrobat dirty flag Layer 2）は根本原因調査中につき、本バージョンでは「既知問題・次版送り」として明示合意の上でリリース可とする。

---

## 7. ロール・責任

| ロール | 担当者 | 責務 |
|---|---|---|
| 計画（本文書） | PM（ココ） | リスク抽出・スコープ定義・受入基準策定 |
| アーキテクチャ分析 | Architect（ぼたん） | PDF 保存パイプライン・メモリ管理・LRU 設計レビュー |
| テスト設計（acceptance） | Tester-Unit（あやめ） | `test:pdf:acceptance` ケース拡充、C-01〜C-05 シナリオ設計 |
| テスト設計（integration） | Tester-Integration（まつり） | H-05・H-06 シナリオ設計、IDB 障害注入テスト |
| ケース実装・拡充 | Tester（おかゆ） | 新規ケース実装（gap 充足） |
| コード実装 | Coder（ぺこら / フブキ / シオン / あくあ） | テストコード・プロダクションコードの修正 |
| コードレビュー | Reviewer（マリン / スバル / ノエル / るしあ） | PR レビュー・受入基準との照合 |
| ドキュメント | TechWriter（ロボ子） | テスト結果レポート・MANUAL.md 更新 |
| Acrobat 実機確認 | ユーザー | Tier 3 手動 A/B テスト実施 |

---

## 8. スケジュール（本セッション内フェーズ）

本テスト計画を起点として、以下の 7 フェーズを順次実施する。

| フェーズ | 内容 | 成果物 |
|---|---|---|
| Phase 1（本文書） | テスト計画書作成 | `docs/test-process/01-plan.md` |
| Phase 2 | テストギャップ分析（現存テスト vs リスクマトリクス） | `docs/test-process/02-gap-analysis.md` |
| Phase 3 | テストケース設計（Critical/High を優先） | `docs/test-process/03-test-cases.md` |
| Phase 4 | テストコード実装（C-01〜C-05・H-03〜H-07） | `src/__tests__/` 配下の新規・拡充ファイル |
| Phase 5 | テスト実行・結果記録 | `docs/test-process/05-results.md` |
| Phase 6 | Tier 3 手動確認チェックリスト | `docs/test-process/06-manual-checklist.md` |
| Phase 7 | テスト完了レポート | `docs/test-process/07-report.md` |

---

## 9. 想定リスク・既知の制約

### 自動化が困難な項目

| 項目 | 制約理由 | 対応 |
|---|---|---|
| Acrobat dirty flag 検出 | Acrobat のプロセス内部状態は外部から観測不可 | Tier 3 手動 A/B のみ |
| Acrobat 7.0 実機 BT...ET 表示確認 | Claude 実行環境からは Acrobat 起動不可 | ユーザー手動必須 |
| Tauri sidecar クラッシュ中断 | プロセス強制終了のシミュレーションが難しい | 統合テスト内で Worker null 注入で代替 |
| バックアップ復元ダイアログ（BackupRestoreDialog） | Tauri `check_pending_backups` コマンドのモック化が複雑 | 手動確認チェックリストに追加 |

### 既知の未解決リスク（次版送り合意済み）

- **H-01**: Acrobat dirty flag Layer 2（CIDFontType0 /CIDToGIDMap・Contents 配列 wrapper）
  - `issue_acrobat_save_prompt.md` に詳細記載。Layer 1（no-op short-circuit・/ID 保持）は実装済み
- **M-04**: `fontBytes` ArrayBuffer transfer による連続保存時のフォント喪失
  - `HANDOVER.md` に修正方法記載済み（`fontBytes?.slice()` で解消可能）
- **L-04**: pdfjs Worker の `document.createElement` polyfill
  - `MEMORY.md` 記載。thumbnail.worker.ts 等の render() 前に必須

### テスト実行上の制約

- `test:pdf:soak` 内のリアル PDF テストは機密 PDF を参照しているためコミット禁止（`MEMORY.md` 参照）
- Playwright E2E は Tauri dev server（`localhost:1420`）の起動を前提とする
- `npm run test:tauri`（`cargo test`）は Rust ビルドチェーン必須、Node 単体では実行不可

---

*このドキュメントは Phase 1 成果物。Phase 2 以降でリスクごとのカバレッジマップを作成する。*
