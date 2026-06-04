# Changelog

このプロジェクトは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
[Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

---

## [2.0.14] - 2026-06-04

> **Release Candidate (RC)**
>
> v1.6.3 以来 336 コミットを経た 2.x 系初の正式リリース候補。
> Tauri v2 へのフルマイグレーション、UI リアーキテクチャ、OCR エンジン刷新、
> および 2026-06-03〜04 の集中安定化セッション（PCT-001〜040）を経て RC に到達。
>
> **リリース前提条件**: `tauri-plugin-updater` の署名公開鍵（pubkey）が未設定。
> 本番リリースには `tauri.conf.json` の updater pubkey 設定が必須。

### Added

#### UI
- Excel 風リボン UI を導入し、従来の MenuBar を廃止 (#272〜#277)
  - タブ・グループ・ラージ/スモールボタンの 4 フェーズ段階実装
  - ResizeObserver によるレスポンシブ折り畳み
  - Alt キーアクセラレータ対応

#### OCR
- OCR 言語選択・多言語対応 (#190)
- 信頼度の可視化と低信頼テキストのハイライト表示 (#192)
- ページ範囲指定 OCR (#199)
- 選択矩形内の部分再 OCR (#191)
- OCR 処理中の残り時間・平均処理速度 (ms/ページ) 表示 (#200)
- 既存テキストレイヤーを検出して OCR をスキップし、テキストを取り込む機能 (#204)
- `run_ocr` をバイトベースの Tauri invoke に変更し、fs-scope 依存を排除 (#285)

#### ページ操作
- ページの削除・並べ替え (#193)
- ページ回転（90°/180°/270°）(#207)
- 別 PDF へのページ抽出 (#208)

#### バッチ処理
- フォルダ一括 OCR・エクスポート・保存 (#195)

#### 編集
- 校正辞書：ルールセットの保存・読込・一括適用 (#198)
- ポリライン曲線作成 UI (#205)
- 分割位置の文字境界スナップ＋ホバープレビュー (#288)
- 連続分割モード（Esc キーでキャンセル）(#292)
- 曲線テキストの動的オーバーレイ描画（選択ブロック対応）(#290)

#### 保存 / PDF
- SaveDialog 圧縮プリセット (#206)
- 共有ユーティリティ `writeFileChunked` / `writeFileAtomically` (#210)
- 自動アップデーター（`tauri-plugin-updater`）配線 (#274)
  - 製品名を `Peco` に変更
  - updater アセットパターン整合

### Changed

#### 検索・ハイライト
- 検索ヒットのオーバーレイ強調表示と前後ナビゲーション (#196)

#### ストア / アーキテクチャ
- ストアを infra / viewer / search スライスに分割 (#271, #278 ほか)
- IDB I/O を `usePageManagement` フックへ委譲 (#254)
- `pageOrder` をストア正規表現として一元管理（store-canonical 化）(#209)

#### PDF 互換性
- Acrobat 7 互換のため TJ 演算子を Tj に正規化、曲線グリフのワードブレーク対応 (#1)

### Fixed

#### 保存の整合性（PCT-002, 011, 034〜039）
- PDF 保存 Worker のリクエストに `pageOrder` が含まれず、ページ順変更が反映されない問題 (PCT-002)
- 保存時に `PecoToolBBoxes` メタが新表示順にリマップされず、再読込で別ページの OCR 枠が復元される問題 (PCT-011)
- 非 identity `pageOrder` の PDF 保存後もストア側 `pageOrder` が古いままで、2 回目保存で再度並べ替え・削除され得る問題 (PCT-034)
- dirty ページなしの削除・並べ替え保存が元 PDF バイトをそのまま返し、構造変更を落とす問題 (PCT-035)
- 保存中 await 後に古い `document.pages` と新しい `pageOrder` が混在し、別物理ページへ dirty を適用する問題 (PCT-037)
- 保存後 pageOrder 正規化で構造履歴だけ消し、古い display index の undo が別ページを上書きする問題 (PCT-038)
- 保存中のポスト・スナップショット編集が保存後の `lastSavedActionIndex` / `isDirty` 更新で保存済み扱いになる問題 (PCT-039)

#### OCR の整合性（PCT-001, 005〜009, 025〜030）
- `currentPageIndex` / `pageOrder` / 元 PDF ページインデックスの混同によりページ削除・移動後の OCR/表示/保存対象がずれる問題 (PCT-001)
- OCR 中の保存で、OCR 完了後の変更が一時変更クリアと競合する問題 (PCT-005)
- OCR キャンセル後に結果反映直前のキャンセルチェックがなく、キャンセル後もページを書き換える問題 (PCT-006)
- 全ページ/範囲 OCR の既存 OCR 確認が IDB 退避ページを見ず、未ロードページの OCR 有無を誤判定する問題 (PCT-007)
- OCR current-page の regression テストが旧 `imagePath` 契約のままで現行 `imageBytes` 実装を検証できていなかった問題 (PCT-009)
- `loadPage` が pageOrder 変更後もソースインデックスで IDB 一時変更を読み、退避ページの OCR/編集が別ページに混入する問題 (PCT-025)
- `clearOcrAllPages` が IDB 退避ページへ空 OCR 状態を書かず、未ロードページの OCR が復活する問題 (PCT-026)
- `clearOcrAllPages` の IDB 空 OCR 書き込みが既存 pending save を待たず、古い OCR が後勝ちして復活する問題 (PCT-028)
- LRU 保存失敗ロールバックが旧 OCR をメモリへ復活させる問題（generation guard で対応）(PCT-030)

#### ページ管理・IDB（PCT-029, 031, 032）
- `usePageManagement` 経由のページ削除・移動 IDB rename/delete が pending tracking されず保存/読込と競合する問題 (PCT-029)
- 同一ティックのページ削除・移動連打で IDB rename/delete が競合する問題（hook ローカル操作キューで対応）(PCT-031)
- IDB delete/rename ヘルパーが失敗を握り潰し `lastIdbError` へ伝播しない問題 (PCT-032)

#### サムネイル（PCT-010, 012〜024, 033）
- 別ウィンドウの `ThumbnailWindow` が `pageOrder` を Worker へ渡さず、ページ移動後のサムネイルがずれる問題 (PCT-010)
- main ThumbnailPanel で pageOrder 変更前の旧 Worker 応答が変更後の pending を解決し得る問題（requestId ガード）(PCT-012)
- ファイル切替前の旧 Worker 応答が新ファイルの pending へ混入し得る問題（requestId / file epoch ガード）(PCT-013, 015)
- `ThumbnailWindow` の stale response 防止が機能していなかった問題（requestId ガード）(PCT-014)
- `ThumbnailWindow` の LOAD_PDF 中に pageOrder 変更が来ると `isPdfReady=false` のままキューが詰まる問題 (PCT-016)
- main ThumbnailPanel が `documentEpoch` を購読せず、同一 filePath 更新で旧 PDF/cache を使い続ける問題 (PCT-017)
- `useThumbnailWindow` が `documentEpoch` を通知せず、別ウィンドウが同一 filePath 更新を再読込できない問題 (PCT-018)
- `ThumbnailWindow` の file-opened で listener Map をクリアし、既存 item が再購読しない問題 (PCT-019)
- `ThumbnailWindow` の Worker エラー時に LOAD_PDF 待ち Promise が解決されない問題 (PCT-020)
- `ThumbnailWindow` unmount 時に保持済み ObjectURL をリボークしない問題 (PCT-021)
- `thumbnail.worker` で LOAD_PDF 中に `activeRenders` を 0 へ戻すため、旧 render 完了後に負数化する問題 (PCT-022)
- main ThumbnailPanel のキュー重複判定が O(n) で、大量ページ高速スクロール時に詰まりやすい問題（Set による O(1) 化）(PCT-023)
- `ThumbnailWindow` が大容量 PDF を Worker 数ぶん ArrayBuffer 複製し、メモリピークが大きい問題（Worker が URL を直接ロード）(PCT-024)
- 別ウィンドウの `ThumbnailWindow` がページ削除後の `totalPages` を更新せず、削除済みサムネイルを選べる問題 (PCT-033)

#### バッチ保存（PCT-036）
- フォルダ/バッチ OCR 保存が OCR 完了直後の `isOcrRunningRef` にブロックされ、overwrite/sidecar 保存に失敗する問題 (PCT-036)

#### キーボードショートカット（PCT-003, 008）
- `Ctrl+0` 実行時にページ寸法未ロードだと `isAutoFit` だけ立って zoom が更新されない問題 (PCT-003)
- `Ctrl+0` が日本語配列/テンキー等で `e.key === '0'` にならずショートカットが発火しない問題 (PCT-008)

#### E2E テスト（PCT-027）
- Playwright E2E `ribbon.spec.ts` の Help タブ期待文言が実 UI とズレていた問題 (PCT-027)

#### テスト基盤（PCT-040）
- `tauriCapabilityIntegrity` の mkdir ガードが #285 (byte-based OCR) による JS 側 mkdir 撤廃後も誤失敗し、広域 `npm test` が赤くなる問題（条件付きガードで対応・runtime 実害なし）(PCT-040)

### Performance

- `replaceTextBatch` による一括テキスト置換の高速化 (#213)
- 不要な再描画抑制のための debounce 導入 (#222)
- per-glyph save/restore 呼び出し削減 (#240)
- diff scan cap によるスキャン上限制御 (#249)
- main ThumbnailPanel のキュー重複判定を O(n) から O(1) に改善（Set 活用）(PCT-023)
- `ThumbnailWindow` の大容量 PDF メモリピーク削減（ArrayBuffer 複製廃止）(PCT-024)

### Security

- `fs:allow-mkdir` capability を削除（#285 で JS 側 mkdir 撤廃済み・最小権限原則）(PCT-040, RC Hardening)
- 保存原子性の強化: `replace_pdf_file`（Rust）の atomic-replace コアをテスト注入可能な形に抽出し、temp→target 移動失敗時の元ファイル復元と復元失敗時のバックアップパス保持を cargo テストで検証（RC Hardening）

---

## [1.6.3] - (前回リリース)

これ以前の変更履歴は `git log v1.6.3` を参照してください。

---

[Keep a Changelog]: https://keepachangelog.com/ja/1.1.0/
[Semantic Versioning]: https://semver.org/lang/ja/
[2.0.14]: https://github.com/Ryo_Jonishi/pecotool_v2/compare/v1.6.3...v2.0.14
