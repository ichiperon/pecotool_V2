# PecoTool v2 自動テスト要件書

> **改定日**: 2026-04-16
> **改定理由**: 実装の進化（LRU キャッシュ、IDB 永続化、bitmapCache、bulkReorder、ocrSort 等）に対してテスト要件が追従していなかったため、全面的に再策定。

---

## テスト戦略

| レイヤー       | フレームワーク     | 対象                           | テスト数 |
| -------------- | ------------------ | ------------------------------ | -------- |
| ユニット       | Vitest             | `utils/`, `store/`             | 144      |
| コンポーネント | Vitest + RTL       | `src/components/`              | 60       |
| 統合テスト     | Vitest             | クロスモジュール・ワークフロー | 26       |
| E2E            | Playwright + Tauri | エンドツーエンドシナリオ       | 20       |

### テストピラミッド方針

```
        /  E2E (20)  \          ← Tauri 起動必須。スモークテスト中心
       / 統合 (26)     \        ← Store + Utils 横断ワークフロー
      / Component (60)   \      ← RTL でレンダリング + ユーザー操作
     / Unit (144)          \    ← 純粋ロジック。モック最小限
```

### モック戦略

| 対象                            | モック方式                                  |
| ------------------------------- | ------------------------------------------- |
| Tauri API (`@tauri-apps/api/*`) | `vi.mock` でスタブ                          |
| pdfjs-dist                      | Worker / PDFPageProxy をスタブ              |
| Canvas 2D Context               | `getContext` → minimal stub (setup.ts)      |
| IndexedDB                       | `fake-indexeddb` or vi.mock                 |
| `crypto.randomUUID`             | 決定的 ID 生成用に `vi.fn`                  |
| `@dnd-kit/*`                    | DndContext + useSortable の部分モック       |
| lucide-react                    | Proxy で null コンポーネント返却 (setup.ts) |

---

## Phase 1 — ユニットテスト (144 件)

---

### 1.1 pecoStore.ts (62 件)

#### Undo/Redo

| ID      | テスト内容                                        | 期待結果                                     |
| ------- | ------------------------------------------------- | -------------------------------------------- |
| U-PS-01 | `pushAction(action)` → undoStack に追加           | `undoStack.length === 1`                     |
| U-PS-02 | pushAction 時に redoStack がクリアされる          | `redoStack === []`                           |
| U-PS-03 | 101 回 pushAction → スタック上限 100 で最古が破棄 | `undoStack.length === 100`                   |
| U-PS-04 | `undo()` → undoStack から redoStack に移動        | `undoStack === []`, `redoStack === [action]` |
| U-PS-05 | undo で `action.before` のページデータに復元      | ページデータが before と一致                 |
| U-PS-06 | undo 後 isDirty=true                              | `isDirty === true`                           |
| U-PS-07 | undoStack 空の時 undo は no-op                    | 状態変化なし                                 |
| U-PS-08 | document=null 時 undo は no-op                    | エラーなし、状態変化なし                     |
| U-PS-09 | `redo()` → redoStack から undoStack に移動        | `redoStack === []`, `undoStack === [action]` |
| U-PS-10 | redo で `action.after` のページデータに復元       | ページデータが after と一致                  |
| U-PS-11 | redo 後 isDirty=true                              | `isDirty === true`                           |
| U-PS-12 | redoStack 空の時 redo は no-op                    | 状態変化なし                                 |
| U-PS-13 | undo → redo のラウンドトリップでデータ保全        | action.after と一致                          |

#### updatePageData

| ID      | テスト内容                                               | 期待結果                          |
| ------- | -------------------------------------------------------- | --------------------------------- |
| U-PS-14 | updatePageData でデフォルト isDirty=true                 | `isDirty === true`                |
| U-PS-15 | `isDirty: false` 指定時はグローバル isDirty を更新しない | isDirty は前回値のまま            |
| U-PS-16 | 部分データのマージ（既存 width=100 に height=200 追加）  | 両方保持                          |
| U-PS-17 | 未存在ページへの更新でページ自動作成                     | `pages.get(5)` が存在             |
| U-PS-18 | undoable=true (デフォルト) で undo アクション生成        | undoStack に before/after 記録    |
| U-PS-19 | undoable=false で undo アクション非生成                  | undoStack 不変                    |
| U-PS-20 | 未存在ページ (oldPage なし) へのundoable更新はundo非記録 | undoStack 不変                    |
| U-PS-21 | 101 回の undoable 更新でスタック上限 100                 | `undoStack.length === 100`        |
| U-PS-22 | undoable 更新時に redoStack クリア                       | `redoStack === []`                |
| U-PS-23 | LRU 退避: 51 ページロードで MAX_CACHED_PAGES=50 以下     | `pages.size <= 50`                |
| U-PS-24 | LRU 退避: currentPageIndex は退避されない                | カレントページが Map に残存       |
| U-PS-25 | LRU 退避: dirty ページは IDB 保存される                  | `saveTemporaryPageDataBatch` 呼出 |
| U-PS-26 | pageAccessOrder が updatePageData で更新                 | アクセス順先頭に移動              |

#### Selection

| ID      | テスト内容                               | 期待結果                            |
| ------- | ---------------------------------------- | ----------------------------------- |
| U-PS-27 | toggleSelection 単一モード: 排他選択     | 新 ID のみ選択                      |
| U-PS-28 | toggleSelection マルチモード: 追加選択   | 両 ID が selectedIds に含まれる     |
| U-PS-29 | toggleSelection マルチ: 既選択を解除     | 対象 ID が除去                      |
| U-PS-30 | toggleSelection で lastSelectedId 更新   | `lastSelectedId === 'x'`            |
| U-PS-31 | 最終選択 ID の解除で lastSelectedId=null | `lastSelectedId === null`           |
| U-PS-32 | setSelectedIds で選択を一括置換          | 指定した全 ID が選択状態            |
| U-PS-33 | setSelectedIds([]) で全解除              | selectedIds 空、lastSelectedId=null |
| U-PS-34 | clearSelection でリセット                | selectedIds 空、lastSelectedId=null |

#### Clipboard

| ID      | テスト内容                                         | 期待結果                          |
| ------- | -------------------------------------------------- | --------------------------------- |
| U-PS-35 | copySelected: 選択ブロックを clipboard にコピー    | clipboard に 2 件                 |
| U-PS-36 | copySelected: ディープコピー（参照非共有）         | 元ブロック変更後も clipboard 不変 |
| U-PS-37 | copySelected: 未選択時 no-op                       | clipboard 不変                    |
| U-PS-38 | copySelected: document=null 時 no-op               | clipboard 不変                    |
| U-PS-39 | pasteClipboard: 新規 UUID 生成                     | ID が元と異なる                   |
| U-PS-40 | pasteClipboard: 位置オフセット +10,+10             | bbox.x/y が +10                   |
| U-PS-41 | pasteClipboard: isNew=true, isDirty=true           | フラグ確認                        |
| U-PS-42 | pasteClipboard: selectedIds がペースト先 ID に更新 | 新 ID のみ選択                    |
| U-PS-43 | pasteClipboard: 既存 textBlocks に追加             | 合計数が増加                      |
| U-PS-44 | pasteClipboard: order が既存の続番                 | `order: 3` (既存 0,1,2)           |
| U-PS-45 | pasteClipboard: clipboard 空時 no-op               | 状態変化なし                      |

#### Clear OCR

| ID      | テスト内容                                          | 期待結果                                |
| ------- | --------------------------------------------------- | --------------------------------------- |
| U-PS-46 | clearOcrCurrentPage: 現在ページの textBlocks 全削除 | `textBlocks === []`, `isDirty === true` |
| U-PS-47 | clearOcrCurrentPage: 他ページは影響なし             | 他ページのブロック不変                  |
| U-PS-48 | clearOcrCurrentPage: document=null 時エラーなし     | 例外なし                                |
| U-PS-49 | clearOcrAllPages: 全ロード済ページクリア            | 全ページ textBlocks=[], isDirty=true    |
| U-PS-50 | clearOcrAllPages: 未ロードページにもスタブ作成      | totalPages 分の空ページが存在           |
| U-PS-51 | clearOcrAllPages: undo/redo スタッククリア          | 両スタック `[]`                         |
| U-PS-52 | clearOcrAllPages: グローバル isDirty=true           | `isDirty === true`                      |

#### setCurrentPage / setDocument

| ID      | テスト内容                                      | 期待結果                                            |
| ------- | ----------------------------------------------- | --------------------------------------------------- |
| U-PS-53 | setCurrentPage で currentPageIndex 更新         | `currentPageIndex === 3`                            |
| U-PS-54 | setCurrentPage で pageAccessOrder 先頭に移動    | `pageAccessOrder[0] === 3`                          |
| U-PS-55 | setCurrentPage で accessOrder 内の重複排除      | 重複なし                                            |
| U-PS-56 | setCurrentPage で selection クリア              | selectedIds 空                                      |
| U-PS-57 | setDocument で全一時状態リセット                | currentPageIndex=0, undoStack=[], selectedIds 空 等 |
| U-PS-58 | setDocument + pendingRestoration → isDirty=true | `isDirty === true`                                  |
| U-PS-59 | setDocument (restoration なし) → isDirty=false  | `isDirty === false`                                 |
| U-PS-60 | setDocument(null) で document クリア            | `document === null`                                 |
| U-PS-61 | setDocument に originalBytes 保持               | `originalBytes === bytes`                           |
| U-PS-62 | setDocument で pendingRestoration クリア        | `pendingRestoration === null`                       |

---

### 1.2 ocrSettingsStore.ts (14 件)

| ID      | テスト内容                        | 期待結果                            |
| ------- | --------------------------------- | ----------------------------------- |
| U-OS-01 | デフォルト horizontal.rowOrder    | `'top-to-bottom'`                   |
| U-OS-02 | デフォルト horizontal.columnOrder | `'left-to-right'`                   |
| U-OS-03 | デフォルト vertical.columnOrder   | `'right-to-left'`                   |
| U-OS-04 | デフォルト vertical.rowOrder      | `'top-to-bottom'`                   |
| U-OS-05 | デフォルト groupTolerance         | `20`                                |
| U-OS-06 | デフォルト mixedOrder             | `'vertical-first'`                  |
| U-OS-07 | setHorizontalRowOrder 更新        | 対象フィールドのみ変更              |
| U-OS-08 | setHorizontalColumnOrder 更新     | 対象フィールドのみ変更              |
| U-OS-09 | setVerticalColumnOrder 更新       | 対象フィールドのみ変更              |
| U-OS-10 | setVerticalRowOrder 更新          | 対象フィールドのみ変更              |
| U-OS-11 | setGroupTolerance 更新            | `groupTolerance === 50`             |
| U-OS-12 | setMixedOrder 更新                | `mixedOrder === 'horizontal-first'` |
| U-OS-13 | persist キー名                    | `'peco-ocr-settings'`               |
| U-OS-14 | localStorage ラウンドトリップ     | 値が永続化・復元される              |

---

### 1.3 ocrSort.ts (21 件)

#### sortHorizontal

| ID      | テスト内容                         | 期待結果                         |
| ------- | ---------------------------------- | -------------------------------- |
| U-SR-01 | 上→下、左→右 の基本 2x2 グリッド   | (0,0)→(100,0)→(0,100)→(100,100)  |
| U-SR-02 | 下→上、右→左 の逆順                | 両軸反転                         |
| U-SR-03 | tolerance 内のブロックは同一行扱い | y=50, y=55 が同一行              |
| U-SR-04 | tolerance は center Y 基準         | 高さ違いでも center 一致なら同行 |
| U-SR-05 | 行内ソート: centerX 昇順 (左→右)   | x=50→100→200                     |
| U-SR-06 | 行内ソート: centerX 降順 (右→左)   | x=200→100→50                     |

#### sortVertical

| ID      | テスト内容                  | 期待結果                          |
| ------- | --------------------------- | --------------------------------- |
| U-SR-07 | 右→左列、上→下行            | (200,0)→(200,100)→(50,0)→(50,100) |
| U-SR-08 | 左→右列、下→上行            | 両軸反転                          |
| U-SR-09 | tolerance: X 軸グルーピング | x=100, x=105 が同一列             |

#### groupByTolerance

| ID      | テスト内容                       | 期待結果                      |
| ------- | -------------------------------- | ----------------------------- |
| U-SR-10 | 空入力 → 空グループ              | `[]`                          |
| U-SR-11 | 単一要素 → 1 グループ            | `[[block]]`                   |
| U-SR-12 | 全要素 tolerance 内 → 1 グループ | 全件が 1 配列内               |
| U-SR-13 | tolerance 比較はグループ先頭基準 | 0,15,25(tol=20) → [0,15],[25] |
| U-SR-14 | tolerance=0 → 完全一致のみ       | 100,100,101 → [100,100],[101] |

#### Mixed mode

| ID      | テスト内容                         | 期待結果                |
| ------- | ---------------------------------- | ----------------------- |
| U-SR-15 | vertical-first: 縦書きが先         | V ブロック → H ブロック |
| U-SR-16 | horizontal-first: 横書きが先       | H ブロック → V ブロック |
| U-SR-17 | 全て横書き → sortHorizontal の結果 | V 設定は無関係          |
| U-SR-18 | 全て縦書き → sortVertical の結果   | H 設定は無関係          |

#### Edge case

| ID      | テスト内容      | 期待結果                                  |
| ------- | --------------- | ----------------------------------------- |
| U-SR-19 | 空配列入力      | `[]` 返却                                 |
| U-SR-20 | 単一ブロック    | そのまま返却                              |
| U-SR-21 | center 座標計算 | bbox{x:10,y:20,w:100,h:50} → cx=60, cy=45 |

---

### 1.4 bulkReorder.ts (23 件)

#### classifyDirection

| ID      | テスト内容                         | 期待結果                |
| ------- | ---------------------------------- | ----------------------- |
| U-BR-01 | dx=100, dy=0 → 右                  | `'left-right'`          |
| U-BR-02 | dx=-100, dy=0 → 左                 | `'right-left'`          |
| U-BR-03 | dx=0, dy=100 → 下                  | `'up-down'`             |
| U-BR-04 | dx=0, dy=-100 → 上                 | `'down-up'`             |
| U-BR-05 | dx=100, dy=100 → 左上→右下         | `'topleft-bottomright'` |
| U-BR-06 | dx=-100, dy=-100 → 右下→左上       | `'bottomright-topleft'` |
| U-BR-07 | dx=-100, dy=100 → 右上→左下        | `'topright-bottomleft'` |
| U-BR-08 | dx=100, dy=-100 → 左下→右上        | `'bottomleft-topright'` |
| U-BR-09 | 最小距離未満 (4px) → null          | `null`                  |
| U-BR-10 | 距離=5 は有効                      | null 以外               |
| U-BR-11 | 角度境界 22.4° → left-right のまま | `'left-right'`          |
| U-BR-12 | 角度境界 22.6° → 斜めに遷移        | `'bottomleft-topright'` |

#### reorderBlocks

| ID      | テスト内容                           | 期待結果         |
| ------- | ------------------------------------ | ---------------- |
| U-BR-13 | up-down: Y 昇順主軸、X 昇順副軸      | 正しい順序       |
| U-BR-14 | right-left: X 降順主軸               | 正しい順序       |
| U-BR-15 | threshold 内のブロックは同一グループ | 副軸で追加ソート |
| U-BR-16 | threshold 外は主軸のみでソート       | 主軸厳密ソート   |
| U-BR-17 | 全出力ブロックに isDirty=true        | 全件確認         |
| U-BR-18 | order が 0 始まり連番                | 0,1,2,3,4        |
| U-BR-19 | 空入力 → 空配列                      | `[]`             |
| U-BR-20 | 単一ブロック → order=0, isDirty=true | 1 件             |
| U-BR-21 | topright-bottomleft: Y昇順+X降順     | 複合ソート確認   |

#### getDirectionLabel

| ID      | テスト内容               | 期待結果       |
| ------- | ------------------------ | -------------- |
| U-BR-22 | 8 方向全てに日本語ラベル | 空文字列でない |
| U-BR-23 | null → 空文字列          | `''`           |

---

### 1.5 pdfLoader.ts (18 件)

#### LRU ページプロキシキャッシュ

| ID      | テスト内容                                               | 期待結果             |
| ------- | -------------------------------------------------------- | -------------------- |
| U-PL-01 | キャッシュヒット: getPage 不呼出                         | 同一オブジェクト返却 |
| U-PL-02 | キャッシュヒット: LRU 順序更新                           | 最新位置に移動       |
| U-PL-03 | キャッシュミス: getPage 呼出＋保存                       | 新規取得＋格納       |
| U-PL-04 | 51 ページで eviction → oldest の cleanup() 呼出          | キャッシュサイズ ≤50 |
| U-PL-05 | destroySharedPdfProxy: 全エントリ cleanup + キャッシュ空 | 全 cleanup 呼出      |

#### Shared PDF Proxy

| ID      | テスト内容                               | 期待結果                  |
| ------- | ---------------------------------------- | ------------------------- |
| U-PL-06 | 同一パスで同一 Promise                   | 参照一致                  |
| U-PL-07 | 異なるパスで旧 proxy 破棄＋新規作成      | destroy 呼出 + 新 Promise |
| U-PL-08 | await 中のファイル切替でキャンセルエラー | "cancelled" を含むエラー  |

#### Writing mode 検出

| ID      | テスト内容                        | 期待結果                       |
| ------- | --------------------------------- | ------------------------------ |
| U-PL-09 | transform X 方向優位 → horizontal | `writingMode === 'horizontal'` |
| U-PL-10 | transform Y 方向優位 → vertical   | `writingMode === 'vertical'`   |

#### フォールバック計算

| ID      | テスト内容                  | 期待結果                   |
| ------- | --------------------------- | -------------------------- |
| U-PL-11 | height=0 時のフォールバック | transform スケールから計算 |
| U-PL-12 | width=0 時のフォールバック  | 文字数×0.6×magnitude       |
| U-PL-13 | 空文字列フィルタリング      | textBlocks から除外        |

#### IDB 操作

| ID      | テスト内容                                  | 期待結果                    |
| ------- | ------------------------------------------- | --------------------------- |
| U-PL-14 | saveTemporaryPageDataBatch: thumbnail 除去  | 保存データに thumbnail なし |
| U-PL-15 | loadPage: 一時編集データのマージ            | isDirty=true で返却         |
| U-PL-16 | loadPage: キャッシュ/temp なし → 新規パース | pdfjs から取得              |

#### waitForPendingIdbSaves

| ID      | テスト内容                        | 期待結果                   |
| ------- | --------------------------------- | -------------------------- |
| U-PL-17 | pending なし → 即座に resolve     | 即時完了                   |
| U-PL-18 | pending あり → 全完了後に resolve | 全 Promise settle 後に完了 |

---

### 1.6 pdfSaver.ts (25 件)

#### ストリーム処理

| ID      | テスト内容                        | 期待結果     |
| ------- | --------------------------------- | ------------ |
| U-SV-01 | フィルタなし → 生バイト返却       | そのまま返却 |
| U-SV-02 | FlateDecode → inflate 結果        | 正しく解凍   |
| U-SV-03 | FlateDecode + 破損データ → null   | `null` 返却  |
| U-SV-04 | 非対応フィルタ (LZWDecode) → null | `null` 返却  |
| U-SV-05 | 複合フィルタチェーン → null       | `null` 返却  |
| U-SV-06 | 空フィルタ配列 → 生バイト返却     | そのまま返却 |

#### テキストブロック除去 (stripTextBlocks)

| ID      | テスト内容                                  | 期待結果       |
| ------- | ------------------------------------------- | -------------- |
| U-SV-07 | BT...ET ブロック除去                        | BT~ET 間が削除 |
| U-SV-08 | 非テキスト演算子は保持                      | 変更なし       |
| U-SV-09 | 複数 BT...ET ブロック除去                   | 全ブロック削除 |
| U-SV-10 | 文字列リテラル内の "BT","ET" は誤検出しない | 文字列保持     |
| U-SV-11 | 空ストリーム → 空返却                       | 空 Uint8Array  |
| U-SV-12 | ストリーム全体が 1 つの BT...ET → 空        | 空出力         |

#### 座標変換

| ID      | テスト内容                           | 期待結果                              |
| ------- | ------------------------------------ | ------------------------------------- |
| U-SV-13 | 横書き baselineY 計算                | `height - bbox.y - textHeight*sy*0.8` |
| U-SV-14 | 縦書き rotation = -90°               | `rotate: degrees(-90)`                |
| U-SV-15 | 縦書き baselineY = height - bbox.y   | 正しい値                              |
| U-SV-16 | 横書き sx = bbox.width / textWidth   | スケール計算                          |
| U-SV-17 | 横書き sy = bbox.height / textHeight | スケール計算                          |

#### Dirty ページスキップ

| ID      | テスト内容                            | 期待結果         |
| ------- | ------------------------------------- | ---------------- |
| U-SV-18 | dirty ページのみ処理                  | 他ページは非接触 |
| U-SV-19 | 非 dirty ページは content stream 不変 | 変更なし         |

#### エッジケース

| ID      | テスト内容                                      | 期待結果              |
| ------- | ----------------------------------------------- | --------------------- |
| U-SV-20 | 空テキストブロック → drawText 非呼出            | スキップ              |
| U-SV-21 | textWidth=0 → console.warn + スキップ           | 警告出力              |
| U-SV-22 | 非有限スケール (NaN/Infinity) → スキップ        | 警告出力              |
| U-SV-23 | dirty ページにテキストなし → フォント非埋め込み | `customFont === null` |
| U-SV-24 | BBox メタデータが info dict に書き込まれる      | PecoToolBBoxes 存在   |
| U-SV-25 | 既存 BBox メタデータとのマージ                  | 既存+新規の両方を含む |

---

### 1.7 bitmapCache.ts (10 件) *NEW*

| ID      | テスト内容                                  | 期待結果                   |
| ------- | ------------------------------------------- | -------------------------- |
| U-BC-01 | set → get で取得可能                        | 同一エントリ返却           |
| U-BC-02 | 未登録キー → undefined                      | `undefined`                |
| U-BC-03 | 11 件目で LRU 退避 (上限 10)                | 最古キーが undefined       |
| U-BC-04 | 退避時に bitmap.close() 呼出                | close() 呼出確認           |
| U-BC-05 | 同一キー上書きで旧 bitmap.close() 呼出      | 旧エントリ close()         |
| U-BC-06 | 同一キー上書きで LRU 順序が最新に移動       | 再挿入後に別キーが退避対象 |
| U-BC-07 | clearBitmapCache: 全エントリの close() 呼出 | 全件 close()               |
| U-BC-08 | clearBitmapCache: キャッシュ完全空化        | 全 get → undefined         |
| U-BC-09 | キー形式 "pageIndex:zoom" の動作確認        | 文字列キーで正常動作       |
| U-BC-10 | ちょうど上限 (10 件) では退避なし           | 全件取得可能               |

---

### 1.8 format.ts (10 件)

| ID      | テスト内容                  | 期待結果                |
| ------- | --------------------------- | ----------------------- |
| U-FT-01 | 0 bytes                     | `'0 B'`                 |
| U-FT-02 | 512 bytes                   | `'512 B'`               |
| U-FT-03 | 1024 bytes                  | `'1 KB'`                |
| U-FT-04 | 1536 bytes                  | `'1.5 KB'`              |
| U-FT-05 | 1,048,576 bytes             | `'1 MB'`                |
| U-FT-06 | 1,572,864 bytes             | `'1.5 MB'`              |
| U-FT-07 | 1,073,741,824 bytes         | `'1 GB'`                |
| U-FT-08 | 2,684,354,560 bytes         | `'2.5 GB'`              |
| U-FT-09 | 2048 bytes → 末尾ゼロ非表示 | `'2 KB'` (not '2.0 KB') |
| U-FT-10 | 1 byte                      | `'1 B'`                 |

---

## Phase 2 — コンポーネントテスト (60 件)

---

### 2.1 OcrCard.tsx (17 件)

| ID      | テスト内容                                      | 期待結果                         |
| ------- | ----------------------------------------------- | -------------------------------- |
| C-OC-01 | テキスト編集 → store 更新 + isDirty=true        | blur 後に text 更新              |
| C-OC-02 | テキスト未変更 blur → updatePageData 非呼出     | no-op                            |
| C-OC-03 | writingMode トグル: horizontal → vertical       | store 更新 + isDirty=true        |
| C-OC-04 | writingMode トグル: vertical → horizontal       | store 更新                       |
| C-OC-05 | isDirty=true で ● インジケーター表示            | DOM に ● 存在                    |
| C-OC-06 | isDirty=false で ● 非表示                       | DOM に ● なし                    |
| C-OC-07 | 選択状態で `.selected` クラス付与               | クラス確認                       |
| C-OC-08 | クリックで単一選択                              | selectedIds に block.id のみ     |
| C-OC-09 | Ctrl+クリックで追加選択                         | 既存+新規の両方が selectedIds に |
| C-OC-10 | Ctrl+↓ で次カードナビゲーション                 | onNavigate('down') 呼出          |
| C-OC-11 | Ctrl+↑ で前カードナビゲーション                 | onNavigate('up') 呼出            |
| C-OC-12 | Ctrl なし矢印キーではナビゲーション非発火       | onNavigate 非呼出                |
| C-OC-13 | ドラッグハンドル描画                            | `.ocr-card-drag-handle` 存在     |
| C-OC-14 | 選択カードの自動スクロール                      | scrollIntoView 呼出              |
| C-OC-15 | Shift+クリック → onSelect(id, false, true) 呼出 | shift フラグ付き                 |
| C-OC-16 | 右クリック: 未選択なら選択                      | toggleSelection 呼出             |
| C-OC-17 | order 番号表示                                  | order=5 → "#6" 表示              |

---

### 2.2 OcrEditor.tsx (12 件)

| ID      | テスト内容                                         | 期待結果                             |
| ------- | -------------------------------------------------- | ------------------------------------ |
| C-ED-01 | 検索フィルター (大文字小文字無視)                  | "hello" で "Hello","hEllo2" がマッチ |
| C-ED-02 | 検索クリアで全カード表示                           | 全件表示                             |
| C-ED-03 | document=null → "データなし" 表示                  | メッセージ確認                       |
| C-ED-04 | 現在ページ未ロード → "読み込み中..."               | メッセージ確認                       |
| C-ED-05 | textBlocks=[] → "OCRテキストなし"                  | メッセージ確認                       |
| C-ED-06 | Shift+クリック範囲選択                             | A～C の連続選択                      |
| C-ED-07 | Ctrl+Shift+クリック既存選択拡張                    | A～D の全選択                        |
| C-ED-08 | 単一ドラッグ並べ替え                               | [C, A, B] + isDirty + order 更新     |
| C-ED-09 | 複数選択ドラッグ並べ替え                           | 選択グループ一括移動                 |
| C-ED-10 | 検索中はドラッグ無効 (distance=Infinity)           | ドラッグ不可                         |
| C-ED-11 | DragOverlay に選択件数バッジ表示                   | "3" 表示                             |
| C-ED-12 | カードナビゲーション (Ctrl+↓) で次カードフォーカス | toggleSelection + focusContent       |

---

### 2.3 TextPreviewWindow.tsx (7 件)

| ID      | テスト内容                                   | 期待結果            |
| ------- | -------------------------------------------- | ------------------- |
| C-PW-01 | 初期状態: 空テキストエリア                   | textarea 空         |
| C-PW-02 | preview-update イベントで内容更新            | テキスト反映        |
| C-PW-03 | コピーボタン → clipboard.writeText 呼出      | テキストコピー      |
| C-PW-04 | コピー後 2 秒でボタンテキスト復帰            | "全てコピー" に戻る |
| C-PW-05 | 閉じるボタン → hide + emit('preview-hidden') | 正しいイベント発火  |
| C-PW-06 | マウント時 request-preview 発火              | emit 呼出           |
| C-PW-07 | アンマウント時に全 unlisten 呼出             | クリーンアップ確認  |

---

### 2.4 PdfCanvas.tsx (15 件)

| ID      | テスト内容                                 | 期待結果                         |
| ------- | ------------------------------------------ | -------------------------------- |
| C-CV-01 | 2 つの canvas レイヤー描画 (PDF + overlay) | 2 つの `<canvas>` 存在           |
| C-CV-02 | ブロッククリックで選択                     | toggleSelection 呼出             |
| C-CV-03 | 空エリアクリックで選択解除                 | 選択クリア                       |
| C-CV-04 | 描画モード: ドラッグで新規 BB 作成         | updatePageData + isNew=true      |
| C-CV-05 | 描画モード: 高さ＞幅×1.5 → vertical        | writingMode 確認                 |
| C-CV-06 | 描画モード: 描画後に自動解除               | toggleDrawingMode 呼出           |
| C-CV-07 | リサイズハンドル検出 (SE コーナー)         | dragMode='resize-se'             |
| C-CV-08 | ブロックドラッグ移動                       | bbox.x/y のオフセット            |
| C-CV-09 | 複数ブロック一括移動                       | 全選択ブロックの bbox オフセット |
| C-CV-10 | Alt+ドラッグ → reorderBlocks 呼出          | 方向判定+リオーダー              |
| C-CV-11 | Ctrl+クリック: 選択中ブロックの解除        | toggleSelection(id, true)        |
| C-CV-12 | 分割モード: クリック位置で BB 分割         | 2 ブロック生成                   |
| C-CV-13 | 選択ブロック自動スクロール                 | scrollTo 呼出                    |
| C-CV-14 | ページ読み込みエラー → リトライボタン      | エラーメッセージ + ボタン        |
| C-CV-15 | disableDrawing=true → マウス操作無効       | 状態変化なし                     |

---

### 2.5 SaveDialog.tsx (11 件)

| ID      | テスト内容                                  | 期待結果                     |
| ------- | ------------------------------------------- | ---------------------------- |
| C-SD-01 | 3 つの圧縮オプション表示                    | none, compressed, rasterized |
| C-SD-02 | デフォルト圧縮選択状態                      | 指定ラジオが checked         |
| C-SD-03 | 非圧縮サイズ表示                            | "2 MB"                       |
| C-SD-04 | 圧縮サイズ＋削減率表示                      | "1 MB (50% 削減)"            |
| C-SD-05 | 推定中はスピナー表示                        | Loader2 描画                 |
| C-SD-06 | ラスタライズ選択 → JPEG 品質スライダー表示  | range input 表示             |
| C-SD-07 | 確定 → onConfirm(compression, quality) 呼出 | パラメータ確認               |
| C-SD-08 | ラスタライズ+品質変更 → 値反映              | quality=80                   |
| C-SD-09 | キャンセル → onCancel 呼出                  | 呼出確認                     |
| C-SD-10 | X ボタン → onCancel 呼出                    | 呼出確認                     |
| C-SD-11 | estimatedSizes=null → フォールバック表示    | "サイズ推定不可"             |

---

### 2.6 Toolbar.tsx (16 件)

| ID      | テスト内容                               | 期待結果                  |
| ------- | ---------------------------------------- | ------------------------- |
| C-TB-01 | Undo ボタン: undoStack 空 → disabled     | disabled 確認             |
| C-TB-02 | Undo ボタン: undoStack あり → enabled    | 操作可能                  |
| C-TB-03 | Redo ボタン: redoStack 空 → disabled     | disabled 確認             |
| C-TB-04 | グループ化ボタン: 選択＜2 → disabled     | disabled 確認             |
| C-TB-05 | グループ化ボタン: 選択≧2 → enabled       | 操作可能                  |
| C-TB-06 | 削除ボタン: 選択=0 → disabled            | disabled 確認             |
| C-TB-07 | 描画モード ON → active クラス            | クラス確認                |
| C-TB-08 | 分割モード ON → active クラス            | クラス確認                |
| C-TB-09 | プレビューボタン: open 時 active         | クラス確認                |
| C-TB-10 | OCR ドロップダウン表示                   | "現在のページ"/"全ページ" |
| C-TB-11 | OCR 実行中 → ボタン disabled             | disabled 確認             |
| C-TB-12 | OCR 進捗テキスト                         | "OCR 5/20"                |
| C-TB-13 | OCR 実行中にキャンセルボタン表示         | "キャンセル" 表示         |
| C-TB-14 | document=null → 追加/分割 disabled       | disabled 確認             |
| C-TB-15 | スペース削除ボタン: 選択=0 → disabled    | disabled 確認             |
| C-TB-16 | 設定ドロップダウン: 透明度スライダー表示 | slider 存在               |

---

## Phase 3 — 統合テスト (26 件)

Store + Utils の横断ワークフローを検証。DOM レンダリング不要（hooks は `renderHook` 使用）。

| ID   | テスト内容                                                 | 期待結果                             |
| ---- | ---------------------------------------------------------- | ------------------------------------ |
| I-01 | テキスト抽出パイプライン (横書き)                          | ocrSort で top→bottom, left→right 順 |
| I-02 | テキスト抽出パイプライン (縦書き)                          | ocrSort で right→left 列順           |
| I-03 | ブロックマージ: 3 選択 → 外接矩形 + テキスト結合           | 1 ブロック、isDirty=true             |
| I-04 | Undo フルサイクル: 3 操作 → 3 回 undo                      | 初期状態復元、redoStack=3            |
| I-05 | Redo フルサイクル: undo 後 3 回 redo                       | 操作後状態復元                       |
| I-06 | Undo 後の新操作で redo クリア                              | redoStack 空                         |
| I-07 | Undo スタック上限 (101→100)                                | 最古が破棄                           |
| I-08 | 重複削除: 同一テキスト+近似座標 → 1 件残存                 | 重複除去確認                         |
| I-09 | テキストプレビュー順序 = エディタ順序                      | order 順でテキスト結合               |
| I-10 | ページナビゲーション → currentPageIndex + selection クリア | 状態確認                             |
| I-11 | LRU キャッシュ退避 (55 ページ → ≤50)                       | dirty は IDB 保存                    |
| I-12 | Copy/Paste: オフセット+新UUID+isNew+isDirty                | 全フラグ確認                         |
| I-13 | Bulk reorder: left-right → cx 昇順                         | order 連番                           |
| I-14 | Bulk reorder: right-left → cx 降順                         | order 連番                           |
| I-15 | Bulk reorder: up-down → cy 昇順 + cx 副軸                  | 正しいソート                         |
| I-16 | OCR 設定変更 → ブロック再ソート                            | mixedOrder 反映                      |
| I-17 | キーボード: Ctrl+Z → undo 呼出                             | アクション確認                       |
| I-18 | キーボード: Ctrl+Shift+Z → redo 呼出                       | アクション確認                       |
| I-19 | キーボード: Delete → handleDelete 呼出                     | アクション確認                       |
| I-20 | キーボード: contentEditable 内では Delete 抑止             | handleDelete 非呼出                  |
| I-21 | ズーム: Ctrl+wheel → setZoom                               | zoom+10                              |
| I-22 | ズーム: 下限/上限クランプ                                  | 25 未満/500 超に行かない             |
| I-23 | classifyDirection ユーティリティ                           | 8 方向+null 確認                     |
| I-24 | スペース削除: 半角/全角スペース除去                        | テキスト確認                         |
| I-25 | setDocument: 全編集状態リセット                            | undo/redo/selection クリア           |
| I-26 | formatFileSize ユーティリティ                              | 0B/KB/MB/GB 確認                     |

---

## Phase 4 — E2E テスト (20 件)

Playwright + Tauri DevServer (`http://localhost:1420`)。実際のアプリ UI を操作。

| ID     | テスト内容                               | 期待結果                                          |
| ------ | ---------------------------------------- | ------------------------------------------------- |
| E2E-01 | アプリ起動・初期状態                     | 空状態メッセージ、追加/分割 disabled              |
| E2E-02 | PDF 読み込み                             | Canvas 描画、ページ数表示、サムネイル、OCR カード |
| E2E-03 | テキスト編集 + dirty 状態                | ● 表示、ステータスバー "未保存"                   |
| E2E-04 | BB 描画 (追加モード)                     | 新規カード生成、描画モード自動解除                |
| E2E-05 | Ctrl+Z: Undo                             | 編集が元に戻る                                    |
| E2E-06 | Ctrl+0: フィット表示                     | ズームがフィットに調整                            |
| E2E-07 | Ctrl+F: 検索フォーカス                   | 検索入力にフォーカス                              |
| E2E-08 | プレビューウィンドウ開閉                 | ボタン active トグル                              |
| E2E-09 | Undo/Redo 複数操作横断                   | 3 操作→3 undo→3 redo で完全復元                   |
| E2E-10 | Canvas 上のブロック選択                  | ハイライト + 対応カード selected                  |
| E2E-11 | Ctrl+クリック複数選択                    | 2 ブロック選択 + グループ化ボタン有効化           |
| E2E-12 | グループ化操作                           | マージ結果の 1 カード + テキスト結合              |
| E2E-13 | Delete 操作                              | Canvas + カードからブロック消滅                   |
| E2E-14 | サムネイルクリックでページ遷移           | ページ番号・Canvas・カード更新                    |
| E2E-15 | ステータスバーページ入力ジャンプ         | 指定ページに遷移                                  |
| E2E-16 | 検索フィルター                           | マッチカードのみ表示                              |
| E2E-17 | 保存ダイアログ (Ctrl+Shift+S)            | 圧縮オプション + サイズ推定表示                   |
| E2E-18 | 大規模 PDF スモークテスト (1000+ ページ) | フリーズなし、2 秒以内ナビゲーション              |
| E2E-19 | 分割モード                               | クリック位置で BB 2 分割、モード自動解除          |
| E2E-20 | OCR 実行 (現在のページ)                  | 進捗表示 + ブロック生成                           |

---

## 実装優先度

| 優先度   | フェーズ                 | 理由                               |
| -------- | ------------------------ | ---------------------------------- |
| **最高** | Phase 1 (ユニット)       | 純粋ロジックの網羅。回帰防止の基盤 |
| **高**   | Phase 2 (コンポーネント) | ユーザー操作の正確性保証           |
| **中**   | Phase 3 (統合)           | モジュール間連携の検証             |
| **低**   | Phase 4 (E2E)            | Tauri 起動が必要。CI 統合コスト高  |

## 内部関数のエクスポートに関する推奨

以下の内部関数はクリティカルなバイトレベル処理を含むため、`/** @internal */` 付きで export してユニットテスト可能にすることを推奨:

- `pdfSaver.ts`: `decodeStreamContents`, `stripTextBlocks`
- `ocrSort.ts`: `groupByTolerance` (公開 API `sortOcrBlocks` 経由でも可)

---

*テスト合計: **250 件** (ユニット 144 + コンポーネント 60 + 統合 26 + E2E 20)*
