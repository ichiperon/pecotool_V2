---
name: test-analysis
description: Analyze existing test coverage and derive what-to-test per module. Triggers on "テスト分析", "カバレッジ分析", "what-to-test", "Phase 2 テスト", "ギャップ分析".
metadata:
  type: process
  phase: 2
---

# Phase 2: テスト分析（What-to-Test 導出）

## 用途

`src/` の実装構造・既存テストファイル群・Phase 1 のリスクマトリクスを突き合わせ、「何をテストするべきか」をモジュール単位で導出する。
各モジュールに優先度（Critical / High / Medium / Low）を付与し、既存テストでカバーされていないギャップ（抜け漏れ）を特定する。

元記事（Codex 版）の "Step 2: Test Analysis" に相当する。Claude 版では `architect` が主導し、`tester` がカバレッジ実態を補足するペアで実施する。

## 前提条件

- Phase 1 成果物 `docs/test-process/01-plan.md` が存在すること
- `src/__tests__/` 配下のテストファイル一覧が取得可能なこと（`npm run test -- --reporter=verbose` が実行可能であることが望ましい）

## 実行手順

1. **実装モジュール列挙**: `src/` 配下の主要ファイルを `Glob` で列挙し、機能カテゴリ（PDF 保存 / OCR / Editor / State / UI）に分類する。
2. **既存テストファイルとのマッピング**: `src/__tests__/unit/` / `src/__tests__/components/` / `src/__tests__/integration/` の各ファイルをモジュールに対応付ける。
3. **優先度付与**: Phase 1 リスクマトリクスと「保存パイプラインの正本性 > 編集状態の正本性 > OCR/読込 > UI」の重み付けルールを適用する。
4. **ギャップ特定**: 優先度 High 以上でテスト未対象のモジュール・観点を抽出し「抜け漏れ判定」テーブルにまとめる。
5. **テスト観点マトリクス作成**: 正常系 / 非正常系 / 境界値 / 並行操作 / Undo-Redo / 後方互換 / データ保全 / Acrobat 互換 / パフォーマンス / a11y / 冪等性の横断観点で、各モジュールをスコアリングする。
6. **成果物出力**: `docs/test-process/02-analysis.md` へ書き出す。

## 想定実行ペルソナ

- 主担当: `architect`（獅白ぼたん）
- 補足: `tester`（猫又おかゆ）— 既存テストの実態把握

## 入力

| 入力 | パス / コマンド |
|---|---|
| テスト計画書 | `docs/test-process/01-plan.md` |
| 実装ファイル一覧 | `src/**/*.ts`, `src/**/*.tsx`（Glob） |
| 既存テストファイル一覧 | `src/__tests__/**/*.test.ts`, `src/__tests__/**/*.test.tsx` |

## 出力

| 成果物 | パス |
|---|---|
| テスト分析書（モジュール一覧 + ギャップ） | `docs/test-process/02-analysis.md` |

## 参考

- 本リポの過去成果物: `docs/test-process/02-analysis.md`
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
