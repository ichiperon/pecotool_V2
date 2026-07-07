# bug-hunt round3 レポート（2026-07-07）

対象: round1/2 で未踏だった領域（OCR編集・カーブ/縦書きテキスト経路・未踏 hooks・ダイアログ群）＋round2 backlog の MEDIUM 潰し。
編成: 発見=Fable×2＋Sonnet 系finder＋Orchestrator 直接レビュー／裁定=Orchestrator(Fable)／修正=Sonnet。

## 修正済み（コミット）

| コミット | 内容 |
|---|---|
| 241097b | backlog 潰し第1波: B-1 保存 fallback 経路の直列化（並走保存の後勝ち上書き防止）／B-3 ブロック描画失敗の skippedChars 計上＋bboxMeta 除去（meta/content 乖離解消）／B-8 diff プレビュー待機明けの filePath 再検証／B-9 監査ログの undoStack スナップショット化（構造変更保存で常に空になる問題） |
| 5644b56 | R3 修正本体（編集の正しさ群）: **Virtuoso computeItemKey**（編集テキストが別ブロックへ書かれる交差汚染の根本封じ）／handleGroup・OCR/テキスト層取込4経路の適用前 commit／**curve のロード復元欠落**（保存1往復で消失）／**remapCurveForRotation**（回転×curve の座標取り残し・メタ書込と resetDirty の2箇所）／isCurveDefinition の Number.isFinite 強化／分割ダブルスナップ（累積重み比化）／分割時の curve 解除（二重レイアウト防止）／円弧 ±π 継ぎ目の sweep 正規化（p2 を通る側に固定）／useRegex 置換の lookaround 虚報（String.replace コールバック展開へ・regexReplacePattern.ts 新設）／モーダル表示中のグローバルショートカット封鎖（openModalCount 単一情報源） |
| ce4b0bc | Wave4: ドラッグ中 Space の座標乖離（BB=キャンセル/curve=確定の設計整合な後始末＋buttons===0 多層防御）／自動更新失敗の可視化＋再入ガード／アクション付きトーストの上書き保護（優先度ルール）／バッチ summary CSV の決定論的欠落（React updater 副作用依存を除去・**red 実証で毎回発生と確定**）／実行中バッチの ✕ ガード |

検証: 各修正 red→green 実証・広域 npm test 2,798 緑（157ファイル）・critical 366 緑・cargo 91 緑・tsc/eslint 新規指摘なし。

## 特記事項（狩りの学び）

- 保存パイプライン・store 本体は round1/2 の防波堤が効いており、直撃 CRITICAL はゼロ。round3 の HIGH はすべて「編集 UI と永続化の境界」（Virtuoso の再利用・contentEditable の flush タイミング・curve のロード欠落）に集中した
- 「※要検証」候補の red 実証は価値が高い: バッチ CSV は狩り段階で timing 依存の推測だったが、テストで**決定論的バグ**と確定した
- 既存テストがバグを固定化していた例: arcHandlePositions の [-π,π] 丸め検証。期待値変更は理由コメント付きで実施

## backlog（未修正の残余）

### MEDIUM（実機確認 or 設計判断が先）
| ID | 内容 | 次アクション |
|---|---|---|
| R3-B1 | contentEditable の Enter 改行が commit の textContent 読みで消える疑い（「東京⏎大阪」→「東京大阪」で保存） | WebView2 実機でカード Enter→blur→store 確認。成立なら execCommand('insertText','\n') 方式等で修正 |
| R3-B2 | contentEditable が挿入する U+00A0 (nbsp) が無正規化で保存テキスト層に混入する疑い | 実機で「a␣␣b」入力→codePoint 確認。成立なら commit 時正規化 |
| R3-B3 | curve のグリフアンカーが表示（中心揃え）と保存（ベースライン左端）で不一致 | 設計照会（意図的近似か）→ design-review で視覚検証 |
| R3-B4 | 縦書き×curve の fontSize が表示(height基準)と保存(width基準)で別式 | 同上 |
| R3-B5 | curve ブロックの bbox ドラッグに curve が追従しない（グリフが旧位置に残存） | 追従 or ドラッグ抑止の仕様判断 → /feature |
| R3-B6 | 保存側 curve 分岐の isCurveDefinition ガード欠落＋useAutoBackup の isValidBackupData が curve 非検証 | load 側は R3 で検証済み。保存側 truthiness とバックアップ取込の2箇所に横展開 |
| R3-B7 | composition 中断時の data-composing 残留で flush 恒久停止の疑い（推定） | IME 変換中の blur/unmount 反復を実機観察 |

### LOW（機会があれば）
- alt-drag（バルク並べ替え）・新規描画に buttons===0 ガード未適用（Wave4 の Space ドラッグ修正と同型の穴の可能性・BB move/resize 側は対処済み）
- arc の縮退ガード（polyline #424 の横展開・最小半径/弦長）／buildPageRotationCm の重複実装 drift／curve handle クリックのみで dirty 化＋no-op undo／ドラッグ中 Ctrl+wheel ズームの座標空間混在／分割後の selectedIds が dead id 残留／canvas 1px 逸脱での即確定（onMouseLeave）
- 更新チェックの isPdfEncrypted 末尾2KBスキャン／usePageExtraction の範囲外 undefined 素通り／formatFileSize の1TB超・実装重複／useFontLoader の disable×in-flight レース／saveDiffSummary の並べ替え後ページ番号表示／TextPreviewWindow clipboard reject 未処理／useLayoutPanels のウィンドウ外 mouseup／handleExport の filePath 欠如時黙殺
- モーダル関連: diffPreviewRequest.ts のコメントが R3 修正で古くなった（/doc-sync 対象）

### 棄却（理由付き）
- textExport / pdfPageExtractor の pageOrder 反映懸念: 検算の結果シロ（doc.pages は displayIndex キーで re-key 済み）
- 「モーダル中に Ctrl+F 等の非破壊系も止まる」仕様変更: 取りこぼし防止優先の意図的判断として受容

## 実機手動チェックリスト（round3 追加分）

1. [ ] OCRカード編集中に Ctrl+G / 全ページOCR完了 → 編集が正しいブロックに反映され、他ブロックが汚染されない
2. [ ] curve 付きブロック: 保存→再オープンで curve 表示が維持される／回転ページで curve テキストの位置が正しい（実 PDF 目視）
3. [ ] 円弧3点クリック（円の左側を通る配置含む）でテキストが中点クリック側に配置される
4. [ ] 混在幅テキスト（全角＋半角）の分割でプレビュー線と分割結果が一致
5. [ ] ダイアログ表示中に Delete/Ctrl+V が背後に効かない
6. [ ] 正規表現置換で lookbehind/lookahead パターン（例 `(?<=第)3`）が実際に置換される
7. [ ] 複数ファイルのバッチ完走で _summary.csv が生成され完了トーストが出る
8. [ ] カード内 Enter 改行→blur→保存 → テキストに改行が保持されるか（R3-B1 の実機確認）
9. [ ] BB ドラッグ中に Space → ドラッグがキャンセルされ迷子ドラッグにならない（Wave4）
10. [ ] ネットワーク遮断状態で「更新する」→ エラートーストが出る（Wave4）
