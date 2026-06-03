---
name: test-report
description: Generate a test completion report from execution results. Triggers on "テストレポート", "test report", "Phase 7", "完了レポート", "テスト結果まとめ".
metadata:
  type: process
  phase: 7
---

# Phase 7: テスト完了レポート生成

## 用途

Phase 5 のテスト実行結果と Phase 6 の手動確認結果を統合し、リリース判定に必要な情報を含む完了レポート (`docs/test-process/07-report.md`) を生成する。
未解決リスク・次版送り項目・既知問題の明示、および次回テストサイクルへの引き継ぎ事項をまとめる。

元記事（Codex 版）の "Step 7: Test Report" に相当する。Claude 版では `tech_writer`（ロボ子）が主担当、`product_manager`（ここ）がリリース判定を下す。

## 前提条件

- Phase 5 成果物 `docs/test-process/05-results.md` が存在すること
- Phase 6 成果物 `docs/test-process/06-manual-checklist.md` が存在すること（少なくとも着手済みであること）
- Phase 1 の退出基準 (`docs/test-process/01-plan.md` §6) が参照可能であること

## 実行手順

1. **実行結果の集約**: `05-results.md` から vitest 通過数・Playwright 通過数・失敗一覧を取得する。
2. **手動確認結果の集約**: `06-manual-checklist.md` から各チェック項目の完了状態を取得する。
3. **退出基準との照合**: Phase 1 で定義した退出基準と実績値を対照表で記述する。
4. **未解決リスク判定**: Critical / High リスクのうち未解決のものを列挙し、リリース可否・次版送り合意の有無を明示する。
5. **既知問題一覧**: 本バージョンで「次版送り合意済み」とした項目を issue 番号と共に記録する。
6. **引き継ぎ事項**: 次回テストサイクルで最優先に対応すべきギャップを箇条書きにする。
7. **レポート出力**: `docs/test-process/07-report.md` へ書き出す。

### レポート構成テンプレート

```markdown
# PecoTool v2 テスト完了レポート

> バージョン: vX.Y.Z
> 完了日: YYYY-MM-DD
> 作成者: TechWriter (ロボ子)
> リリース判定: ✅ リリース可 / ⚠️ 条件付きリリース可 / ❌ リリース不可

## 1. テスト実行サマリ

| Tier | 実行数 | 通過数 | 失敗数 |
|---|---|---|---|
| Vitest (unit + component + integration) | N | N | N |
| test:pdf:acceptance | 79 | N | N |
| test:state:acceptance | 35 | N | N |
| Playwright E2E | 52 | N | N |
| 手動確認 (Tier 3) | N | N | N |

## 2. 退出基準照合

（退出基準テーブルと実績値の対照）

## 3. 未解決リスク

（Critical / High リスクのリリース可否判定）

## 4. 既知問題（次版送り合意済み）

（issue 番号・内容・合意根拠）

## 5. 次回サイクルへの引き継ぎ

（最優先ギャップ・推奨対応）
```

## 想定実行ペルソナ

- レポート生成: `tech_writer`（ロボ子）
- リリース判定: `product_manager`（桐生ここ）

## 入力

| 入力 | パス |
|---|---|
| テスト実行結果 | `docs/test-process/05-results.md` |
| 手動確認チェックリスト | `docs/test-process/06-manual-checklist.md` |
| テスト計画書（退出基準） | `docs/test-process/01-plan.md` §6 |

## 出力

| 成果物 | パス |
|---|---|
| テスト完了レポート | `docs/test-process/07-report.md` |

## 参考

- 本リポの過去成果物: `docs/test-process/01-plan.md`（退出基準テーブル §6）
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
