---
name: test-execute
description: Execute all test tiers (Unit/Integration/E2E) and record results. Triggers on "テスト実行", "test execute", "テスト走らせ", "Phase 5", "Phase 6", "手動チェックリスト".
metadata:
  type: process
  phase: 5-6
---

# Phase 5+6: テスト実行・手動確認チェックリスト

## 用途

Phase 4 で実装したテストケースを全 Tier にわたって実行し、結果を記録する（Phase 5）。
自動化が困難な Acrobat 実機確認・バックアップ復元ダイアログ等の手動確認項目をチェックリスト形式で提供する（Phase 6）。

元記事（Codex 版）の "Step 5: Test Execution" および "Step 6: Manual Testing" に相当する。
Claude 版では `tester`（おかゆ）が自動実行を主導し、Tier 3 手動確認はユーザーが実施する。

## 前提条件

- Phase 4 成果物（追加テストファイル）が `src/__tests__/` に存在すること
- `tsc --noEmit` がエラーゼロであること
- `eslint` がエラーゼロであること
- Playwright E2E 実行には Tauri dev server (`npm run tauri dev`) の起動が必要

## Phase 5: 自動テスト実行手順

### Tier 1 — Vitest

```bash
# 1. 通常テスト（unit + components + integration、soak 除外）
npm run test -- --run

# 2. PDF 保存 acceptance gate
npm run test:pdf:acceptance

# 3. 状態管理 acceptance gate
npm run test:state:acceptance

# 4. デプロイ前必須チェック（acceptance + state acceptance）
npm run test:critical
```

**期待値**: `test:critical` が全件 pass。vitest 総通過数が前バージョン以上であること。

### Tier 2 — Playwright E2E

```bash
# Tauri dev server を起動してから別ターミナルで実行
npm run test:e2e:ci
```

**期待値**: 52 件以上 pass。

### 結果記録

以下の情報を `docs/test-process/05-results.md` に記録する:

| 項目 | 記録内容 |
|---|---|
| 実行日時 | YYYY-MM-DD HH:MM |
| vitest 通過数 | N/M |
| test:pdf:acceptance 通過数 | N/M |
| test:state:acceptance 通過数 | N/M |
| Playwright E2E 通過数 | N/M |
| 失敗テスト | ファイル名・it 名・エラー要約 |
| 対応方針 | 修正 / skip / 次版送り の判定 |

## Phase 6: 手動確認チェックリスト

以下は Claude 実行環境から自動化不可の項目。ユーザーが実施すること。

### Acrobat 実機確認（Tier 3）

```
[ ] Acrobat 7.0 Professional で保存後 PDF を開き、
    「保存しますか？」ダイアログが出ないことを確認（H-01）
[ ] Acrobat 7.0 Professional で BT...ET エラーなく表示されることを確認（H-02）
[ ] Acrobat Reader（現行版）で保存後 PDF を開き、テキスト選択が読み順どおりであることを確認（H-03）
[ ] Acrobat Reader（現行版）で縦書き OCR テキストの位置が正しいことを確認（H-04）
```

### バックアップ復元確認

```
[ ] アプリ起動時にクラッシュリカバリダイアログが表示されることを確認（H-05）
[ ] バックアップから復元後、編集内容が完全に回復していることを確認
```

### 大規模 PDF 操作確認

```
[ ] 1000 ページ PDF の初期表示が 3 秒以内であることを確認
[ ] ページ遷移が 200ms 以内であることを確認
[ ] メモリ使用量が 500 MB 未満であることを確認
```

### Ribbon / UI 確認

```
[ ] Alt キーアクセラレータが全タブで動作することを確認（M-01）
[ ] 極端に狭いウィンドウ幅（400px 以下）での Ribbon 折りたたみが正常であることを確認（M-02）
```

## 想定実行ペルソナ

- 自動テスト実行: `tester`（猫又おかゆ）
- 結果記録・判定: `product_manager`（桐生ココ）
- 手動確認: ユーザー（自動化不可）

## 入力

| 入力 | パス |
|---|---|
| 追加テストファイル | `src/__tests__/**/*.test.ts` |
| テスト計画書（退出基準） | `docs/test-process/01-plan.md` §6 |

## 出力

| 成果物 | パス |
|---|---|
| テスト実行結果 | `docs/test-process/05-results.md` |
| 手動確認チェックリスト | `docs/test-process/06-manual-checklist.md` |

## 参考

- 本リポの過去成果物: `docs/test-process/01-plan.md`（テストスクリプト一覧 §4）
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
