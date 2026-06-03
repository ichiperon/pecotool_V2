---
name: run-test-process
description: Run all 7 phases of the PecoTool v2 test process in sequence. Triggers on "テストプロセス全体", "run test process", "全フェーズ実行", "テスト一気通貫".
metadata:
  type: process
  phase: all
---

# run-test-process: 全 7 Phase 順次実行 Master Skill

## 用途

PecoTool v2 のテストプロセス（Phase 1〜7）を順次実行するマスタースキル。
各 Phase 完了後にレビューポイントを設け、問題があれば次 Phase 移行前に対処する。

元記事（Zenn: https://zenn.dev/jam0824/articles/c84a2ef393ee70）の Codex 版テストプロセスを Claude Code Skills 形式に翻訳したもの。

## 工数見積もり

| Phase | 元記事（Codex 版） | Claude 版目安 |
|---|---|---|
| Phase 1: テスト計画書作成 | 約 10 分 | 5〜10 分 |
| Phase 2: テスト分析（What-to-Test 導出） | 約 15 分 | 10〜15 分 |
| Phase 3: テスト設計（技法・粒度・命名） | 約 15 分 | 10〜15 分 |
| Phase 4: テストケース実装 | 約 20 分 | 20〜40 分（ギャップ規模次第） |
| Phase 5: 自動テスト実行・結果記録 | 約 5 分 | 5〜10 分 |
| Phase 6: 手動確認チェックリスト | 約 5 分 | 5 分（チェックリスト生成のみ、実施はユーザー） |
| Phase 7: 完了レポート生成 | 約 5 分 | 5〜10 分 |
| **合計** | **約 1 時間 15 分** | **約 1〜2 時間** |

> Claude 版が元記事より長くなる理由: Phase 4 のギャップ充足量（特に `infraStore` 等の新設 store 群のテスト実装）がリポジトリ規模に比例するため。ギャップが少ない場合は元記事と同水準に収まる。

## 前提条件

- リポジトリがクリーンな状態（または変更が把握されていること）
- `tsc --noEmit` がエラーゼロであること
- `npm run test -- --run` が全件通過していること（ベースライン確認）

## 全 Phase 実行手順

### Phase 1: テスト計画書作成

```
/test-plan
```

- 担当: `product_manager`（桐生ここ） + `architect`（獅白ぼたん）
- 成果物: `docs/test-process/01-plan.md`
- 詳細: `.claude/skills/test-plan/SKILL.md`

**レビューポイント 1**: リスクマトリクスの Critical / High 件数が妥当か確認。過不足があれば修正してから Phase 2 へ。

---

### Phase 2: テスト分析（What-to-Test 導出）

```
/test-analysis
```

- 担当: `architect`（獅白ぼたん） + `tester`（猫又おかゆ）
- 成果物: `docs/test-process/02-analysis.md`
- 詳細: `.claude/skills/test-analysis/SKILL.md`

**レビューポイント 2**: ギャップ一覧（§5.3）の High 優先度欠落が許容範囲内か確認。実装コストが高すぎる場合は「次版送り」として Phase 1 のリスクメモに追記。

---

### Phase 3: テスト設計（技法・粒度・命名規約）

```
/test-design
```

- 担当: `tester_unit`（百鬼あやめ） + `tester_integration`（まつり）
- 成果物: `docs/test-process/03-design.md`
- 詳細: `.claude/skills/test-design/SKILL.md`

**レビューポイント 3**: 命名規約・テストレベル割り当てが Phase 4 実装者に伝わる粒度か確認。不明点は `architect`（ぼたん）にレビューを依頼する。

---

### Phase 4: テストケース仕様作成・実装

```
/test-cases
```

- 担当: `tester_unit`（あやめ）[Unit/Component] + `tester_integration`（まつり）[Integration/E2E]
- 成果物: `docs/test-process/04-cases.md` + `src/__tests__/` 追加ファイル
- 詳細: `.claude/skills/test-cases/SKILL.md`

**レビューポイント 4**: `npm run test:critical` が全件通過しているか確認。失敗があれば `coder`（ぺこら）に修正を依頼してから Phase 5 へ。

---

### Phase 5+6: テスト実行・手動チェックリスト

```
/test-execute
```

- 担当: `tester`（おかゆ）[自動実行] + ユーザー[手動 Tier 3]
- 成果物: `docs/test-process/05-results.md` + `docs/test-process/06-manual-checklist.md`
- 詳細: `.claude/skills/test-execute/SKILL.md`

**レビューポイント 5**: 失敗テストが「修正 / skip / 次版送り」のいずれかに判定済みか確認。未判定の失敗が残っていれば Phase 7 に進まない。

---

### Phase 7: テスト完了レポート生成

```
/test-report
```

- 担当: `tech_writer`（ロボ子）[レポート生成] + `product_manager`（ここ）[リリース判定]
- 成果物: `docs/test-process/07-report.md`
- 詳細: `.claude/skills/test-report/SKILL.md`

**最終判定**: Phase 1 の退出基準と実績値を対照し、リリース可 / 条件付きリリース可 / リリース不可 を明示する。

---

## 各 Phase の成果物一覧

| Phase | 成果物ファイル |
|---|---|
| 1 | `docs/test-process/01-plan.md` |
| 2 | `docs/test-process/02-analysis.md` |
| 3 | `docs/test-process/03-design.md` |
| 4 | `docs/test-process/04-cases.md` + `src/__tests__/` 追加分 |
| 5 | `docs/test-process/05-results.md` |
| 6 | `docs/test-process/06-manual-checklist.md` |
| 7 | `docs/test-process/07-report.md` |

## 個別 Phase の再実行

特定フェーズのみやり直す場合は、対応するスキルを直接起動する:

```
/test-plan        # Phase 1 のみ
/test-analysis    # Phase 2 のみ
/test-design      # Phase 3 のみ
/test-cases       # Phase 4 のみ
/test-execute     # Phase 5+6 のみ
/test-report      # Phase 7 のみ
```

## 参考

- 本リポの過去成果物: `docs/test-process/` 配下
- 各 Phase 詳細: `.claude/skills/<skill-name>/SKILL.md`
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
