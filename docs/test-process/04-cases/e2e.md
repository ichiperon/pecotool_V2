# PecoTool v2 テストケース仕様書 — E2E (Playwright)

> Phase 4: テストケース仕様
> 作成日: 2026-06-03
> 前提資料: `docs/test-process/02-analysis.md` / `docs/test-process/03-design.md`
> 対象バージョン: v1.6.9 系（Tauri v2 + React 19 + zustand）

---

## 凡例

| 列 | 説明 |
|---|---|
| ID | `E-XX-NN` 形式（XX = 機能略号、NN = 連番） |
| シナリオ | ユーザーゴールを 1 文で表現 |
| 対象 spec | 実装先 / 既存ファイル名 |
| 優先度 | Critical / High / Medium / Low |
| 状態 | **実装済** / **未実装** |
| Skip 理由 | Tauri 制約・環境依存で自動化困難な場合のみ記載 |

---

## 1. 既存 E2E spec ファイルのマッピング

| ファイル | 対象機能 | 主なテスト ID | ケース数（概算） |
|---|---|---|---|
| `pecotool.spec.ts` | アプリ全体操作 / ファイル操作 / ダーティマーク | E-F-01, E-F-04, E-C-01 | 4 |
| `ribbon.spec.ts` | Ribbon タブ切替 / ボタン表示 | R-01〜R-05 以上 | 5+ |
| `editTab.spec.ts` | Undo/Redo ボタン状態 / 描画モードトグル / グループ化 | ET-01〜ET-06 | 6 |
| `ocrTab.spec.ts` | OCR 実行 / 消去ドロップダウン / 未読込状態 | OT-01〜OT-04 | 4 |
| `ocrEditor.spec.ts` | OcrEditor カード編集 / 並べ替え / 検索フィルタ | OE-01〜OE-05 | 5 |
| `pageNavigation.spec.ts` | サムネイルクリック / ステータスバー / キーボード移動 | PN-01〜PN-05 | 5 |
| `pdfCanvas.spec.ts` | Canvas 描画 / overlay 表示 / pan 操作 | PC-01〜PC-04 | 4 |
| `viewControls.spec.ts` | ズーム / OCR 表示切替 / レイアウト | VC-01〜VC-04 | 4 |
| `textExport.spec.ts` | テキストエクスポート / プレビューウィンドウ | TE-01〜TE-03 | 3 |

**既存合計: 約 40 ケース（52 pass 済のうち本 spec 内訳）**

---

## 2. E2E ケース一覧（全シナリオ）

### 2.1 ファイル操作（E-F）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-F-01 | 初期状態でファイルタブとヘルプテキストが表示される | `pecotool.spec.ts` | High | **実装済** | — |
| E-F-02 | PDF を開くと Canvas とサムネイルが表示される | `pecotool.spec.ts` | Critical | **実装済** | — |
| E-F-03 | Ctrl+S で保存ダイアログが開き保存が完了する | `saveFlow.spec.ts` (新規) | Critical | **未実装** | — |
| E-F-04 | 未編集時は dirty マークが表示されない | `pecotool.spec.ts` | High | **実装済** | — |
| E-F-05 | テキスト編集後に dirty マーク（*）が表示される | `saveFlow.spec.ts` (新規) | High | **未実装** | — |
| E-F-06 | Ctrl+Shift+S で別名保存ダイアログが表示される | `saveFlow.spec.ts` (新規) | High | **未実装** | — |
| E-F-07 | 保存完了後に dirty マークが消える | `saveFlow.spec.ts` (新規) | High | **未実装** | — |
| E-F-08 | 保存中に別ページを編集すると dirty マークが再表示される（race 確認） | `saveFlow.spec.ts` (新規) | High | **未実装** | Tauri invoke mock で疑似遅延が必要 |

---

### 2.2 Ribbon / タブ切替（E-R）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-R-01 | ファイルタブが初期 active で表示される | `ribbon.spec.ts` | High | **実装済** | — |
| E-R-02 | 編集タブに切り替えると Undo/Redo ボタンが表示される | `ribbon.spec.ts` | High | **実装済** | — |
| E-R-03 | OCR タブに切り替えると OCR 実行ボタンが表示される | `ribbon.spec.ts` | High | **実装済** | — |
| E-R-04 | Alt+1 キーでファイルタブに切り替わる（#277 Alt アクセラレータ） | `ribbon.spec.ts` | Medium | **実装済** | — |
| E-R-05 | Alt+2 キーで編集タブに切り替わる | `ribbon.spec.ts` | Medium | **実装済** | — |
| E-R-06 | ウィンドウ幅縮小でボタングループが折り畳まれる（ResizeObserver） | `ribbon.spec.ts` | Medium | **未実装** | Playwright での viewport 縮小が必要 |

---

### 2.3 編集操作（E-ET）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-ET-01 | 初期状態で Undo/Redo ボタンが無効 | `editTab.spec.ts` | High | **実装済** | — |
| E-ET-02 | テキスト編集後に Undo ボタンが有効になる | `editTab.spec.ts` | High | **実装済** | — |
| E-ET-03 | 追加ボタンをクリックすると描画モードがトグルされる | `editTab.spec.ts` | Medium | **実装済** | — |
| E-ET-04 | 選択なし状態ではグループ化・削除ボタンが無効 | `editTab.spec.ts` | Medium | **実装済** | — |
| E-ET-05 | Undo → Redo の round-trip でテキストが元に戻る | `undoRedoFlow.spec.ts` (新規) | Critical | **未実装** | — |
| E-ET-06 | Undo × 3 → Redo × 3 の往復で最終状態が一致する | `undoRedoFlow.spec.ts` (新規) | High | **未実装** | — |

---

### 2.4 OCR 操作（E-OT）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-OT-01 | ファイル未読込時は OCR ボタン群が無効 | `ocrTab.spec.ts` | High | **実装済** | — |
| E-OT-02 | ファイル読込後に OCR 実行ドロップダウンが展開できる | `ocrTab.spec.ts` | High | **実装済** | — |
| E-OT-03 | OCR 消去ドロップダウンが展開できる | `ocrTab.spec.ts` | Medium | **実装済** | — |
| E-OT-04 | OCR 実行後に OcrEditor にカードが表示される | `ocrTab.spec.ts` | High | **実装済** | — |
| E-OT-05 | OCR 中にドキュメントを閉じると OCR が中断される | `ocrCancelFlow.spec.ts` (新規) | High | **未実装** | epoch cancel は UI 側で Tauri mock 遅延が必要 |

---

### 2.5 OcrEditor（E-OE）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-OE-01 | 検索フィルタでカードが絞り込まれる | `ocrEditor.spec.ts` | Medium | **実装済** | — |
| E-OE-02 | カードの DnD で順序が変わる | `ocrEditor.spec.ts` | Medium | **実装済** | — |
| E-OE-03 | カードのテキスト編集後に dirty になる | `ocrEditor.spec.ts` | High | **実装済** | — |
| E-OE-04 | 検索フィルタ + DnD 同時操作で競合しない | `ocrEditor.spec.ts` | Medium | **実装済** | — |
| E-OE-05 | Ctrl+Arrow でカードを移動できる | `ocrEditor.spec.ts` | Medium | **実装済** | — |

---

### 2.6 ページナビゲーション（E-PN）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-PN-01 | ステータスバーに「1 / 2」が表示される | `pageNavigation.spec.ts` | High | **実装済** | — |
| E-PN-02 | サムネイルが 2 件表示される（フィクスチャ 2 ページ） | `pageNavigation.spec.ts` | High | **実装済** | — |
| E-PN-03 | 2 枚目サムネイルクリックで 2 ページ目に遷移する | `pageNavigation.spec.ts` | High | **実装済** | — |
| E-PN-04 | キーボード PageDown で次ページに移動する | `pageNavigation.spec.ts` | Medium | **実装済** | — |
| E-PN-05 | 1 ページ目で PageUp / 最終ページで PageDown が no-op | `pageNavigation.spec.ts` | Medium | **実装済** | — |

---

### 2.7 Canvas / ビューコントロール（E-CV / E-VC）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-CV-01 | PDF ページが Canvas に描画される | `pdfCanvas.spec.ts` | High | **実装済** | — |
| E-CV-02 | OCR 結果オーバーレイが Canvas 上に表示される | `pdfCanvas.spec.ts` | High | **実装済** | — |
| E-CV-03 | pan 操作（マウスドラッグ）でビューが移動する | `pdfCanvas.spec.ts` | Medium | **実装済** | — |
| E-CV-04 | OCR 表示切替ボタンでオーバーレイが非表示になる | `pdfCanvas.spec.ts` | Medium | **実装済** | — |
| E-VC-01 | ズームイン / ズームアウト後に Canvas スケールが変わる | `viewControls.spec.ts` | Medium | **実装済** | — |
| E-VC-02 | ズームをリセットすると 100% に戻る | `viewControls.spec.ts` | Medium | **実装済** | — |

---

### 2.8 テキストエクスポート（E-TE）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-TE-01 | テキストエクスポートボタンでファイルが生成される（mock） | `textExport.spec.ts` | Medium | **実装済** | — |
| E-TE-02 | プレビューウィンドウにテキストが表示される | `textExport.spec.ts` | Medium | **実装済** | — |
| E-TE-03 | エクスポート形式（TXT / CSV）を切り替えられる | `textExport.spec.ts` | Low | **実装済** | — |

---

### 2.9 クロス機能 / エラー系 / 性能（新規未実装）

| ID | シナリオ | 対象 spec | 優先度 | 状態 | Skip 理由 |
|---|---|---|---|---|---|
| E-CF-01 | PDF 開く → OCR 実行 → テキスト編集 → Ctrl+S 保存の通しフロー | `fullWorkflow.spec.ts` (新規) | Critical | **未実装** | — |
| E-CF-02 | Ctrl+Z で OCR 結果が元に戻り、再保存で反映される | `undoRedoFlow.spec.ts` (新規) | High | **未実装** | — |
| E-ER-01 | 書き込み権限なし時に EACCES エラートーストが表示される | `errorHandling.spec.ts` (新規) | High | **未実装** | Tauri mock で EACCES 注入が必要 |
| E-ER-02 | 破損 PDF を開くとエラーメッセージが表示されクラッシュしない | `errorHandling.spec.ts` (新規) | High | **未実装** | 破損 PDF フィクスチャが必要（合成可能） |
| E-ER-03 | IDB エラー発生時にアプリが継続動作し lastIdbError が表示される | `errorHandling.spec.ts` (新規) | Medium | **未実装** | fake-indexeddb mock の E2E 注入が困難 |
| E-PF-01 | 100 ページ PDF でページ切替が 200ms 以内に完了する | `performance.spec.ts` (新規) | Medium | **未実装** | performance.now() での計測が必要 |

---

## 3. カバレッジサマリ

| カテゴリ | 総ケース数 | 実装済 | 未実装 |
|---|---|---|---|
| ファイル操作（E-F） | 8 | 2 | 6 |
| Ribbon（E-R） | 6 | 5 | 1 |
| 編集操作（E-ET） | 6 | 4 | 2 |
| OCR 操作（E-OT） | 5 | 4 | 1 |
| OcrEditor（E-OE） | 5 | 5 | 0 |
| ページナビ（E-PN） | 5 | 5 | 0 |
| Canvas/VC（E-CV/VC） | 6 | 6 | 0 |
| テキストエクスポート（E-TE） | 3 | 3 | 0 |
| クロス機能 / エラー / 性能 | 6 | 0 | 6 |
| **合計** | **50** | **34** | **16** |

---

## 4. Phase 5 への引き継ぎ

### 実装優先順（未実装 16 件）

| Wave | ID | 理由 |
|---|---|---|
| Wave 1 | E-CF-01（通しフロー） | 最重要 E2E シナリオ。保存まで一気通貫で確認 |
| Wave 1 | E-F-03 / E-F-05 / E-F-07（保存フロー） | dirty マーク + Ctrl+S が動くことを UI で確認 |
| Wave 2 | E-ET-05 / E-ET-06（Undo/Redo round-trip） | Critical 操作。Unit では確認済みだが E2E 観点が抜け |
| Wave 2 | E-ER-01（EACCES エラー）/ E-ER-02（破損 PDF） | エラーパスの E2E 確認 |
| Wave 3 | E-F-08 / E-OT-05（race 系） | mock 遅延注入が必要。後回し可 |
| Wave 3 | E-R-06（ResizeObserver） / E-ER-03（IDB） / E-PF-01（性能） | 環境依存・高難度。スキップ可 |

### 新規 spec ファイル提案

```
src/__tests__/e2e/saveFlow.spec.ts          — E-F-03/05/06/07/08
src/__tests__/e2e/undoRedoFlow.spec.ts      — E-CF-02, E-ET-05/06
src/__tests__/e2e/fullWorkflow.spec.ts      — E-CF-01
src/__tests__/e2e/ocrCancelFlow.spec.ts     — E-OT-05
src/__tests__/e2e/errorHandling.spec.ts     — E-ER-01/02/03
src/__tests__/e2e/performance.spec.ts       — E-PF-01
```

### Tauri mock 制約事項

| 制約 | 対象 | 対策 |
|---|---|---|
| 実バイナリ（OCR sidecar）が CI に非搭載 | E-OT-* | `invoke('run_ocr')` を mock で固定レスポンスに差し替え |
| Tauri Updater は stub 経由のみ | — | `__stubs__/tauri-plugin-updater.ts` を E2E helpers にも共有 |
| 実ファイルシステムへの書き込み | E-F-03/06/07 | `write_file_atomically` mock で Uint8Array をキャプチャして検証 |
| IDB は jsdom 依存（Playwright には非搭載） | E-ER-03 | 現状スキップ推奨。代替: Unit で `fake-indexeddb` 使用済み |
