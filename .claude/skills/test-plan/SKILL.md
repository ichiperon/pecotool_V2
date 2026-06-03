---
name: test-plan
description: Generate a test plan document for PecoTool v2. Triggers on "テスト計画", "test plan", "Phase 1 テスト", "リスク抽出".
metadata:
  type: process
  phase: 1
---

# Phase 1: テスト計画書作成

## 用途

PecoTool v2 のリリースサイクルごとにテスト計画書 (`docs/test-process/01-plan.md`) を生成する。
対象バージョンのスコープ・リスクマトリクス・テストアプローチ・進入/退出基準を一気通貫で定義し、Phase 2 以降の分析・設計・実行フェーズへの入力とする。

元記事（Codex 版）の "Step 1: Test Planning" に相当する。Claude 版では `product_manager` ロールが主導し、`architect` がリスク根拠を補足するペアで実施する。

## 前提条件

- `README.md` / `CLAUDE.md`（プロジェクトルート）が最新状態であること
- 前リリースの `docs/test-process/07-report.md` が存在する場合は既知問題一覧を参照可能なこと
- `git status` がクリーンまたは変更内容が把握されていること

## 実行手順

1. **スコープ確認**: `README.md` と直近コミット (`git log --oneline -20`) から本バージョンの変更概要を把握する。
2. **リスク抽出**: 変更概要をもとに Critical / High / Medium / Low の 4 段階でリスクを列挙する。
   - Critical: データロス・クラッシュ・保存破損に直結するもの
   - High: 主要ワークフロー停止につながるもの
3. **テストアプローチ決定**: Tier 1 (Vitest) / Tier 2 (Playwright E2E) / Tier 3 (手動 Acrobat) の三層構成で各リスクをどの Tier でカバーするか割り当てる。
4. **進入基準・退出基準定義**: `tsc --noEmit` / `eslint` / `npm run test` の前提条件と、vitest 通過数・E2E 通過数・Critical リスク件数の目標値を記載する。
5. **ロール・責任表作成**: 各フェーズの担当ロール（ホロデブ部エージェント名）を列挙する。
6. **成果物出力**: `docs/test-process/01-plan.md` へ書き出す。

## 想定実行ペルソナ

- 主担当: `product_manager`（桐生ココ）
- 補足: `architect`（獅白ぼたん）— リスク根拠の技術的裏付け

## 入力

| 入力 | パス / コマンド |
|---|---|
| プロジェクト概要 | `README.md` |
| 変更履歴 | `git log --oneline -20` |
| 前バージョン既知問題 | `docs/test-process/07-report.md`（存在する場合） |
| プロジェクト設定 | `CLAUDE.md`（プロジェクトルート） |

## 出力

| 成果物 | パス |
|---|---|
| テスト計画書 | `docs/test-process/01-plan.md` |

## 参考

- 本リポの過去成果物: `docs/test-process/01-plan.md`
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
