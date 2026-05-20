# PecoTool v2 検査機能 設計書

## 1. 目的

PDF 内の OCR テキストレイヤーと BB の構造破損を検出し、コピー、検索、保存後のテキスト品質に悪影響が出そうな箇所へ素早く移動できるようにする。

本機能は誤字校正ではなく、PecoTool 上で扱う `TextBlock` と `BoundingBox` の整合性検査を目的とする。

## 2. 基本方針

- 既存の PDF 読み込み、OCR 実行、BB 編集、保存処理は変更しない。
- 検査は `PageData.textBlocks` を読み取るだけの非破壊処理とする。
- 検査結果を表示しても `isDirty`、Undo/Redo、保存対象 PDF には影響させない。
- `PecoToolBBoxes`、バックアップ、一時保存 IDB、PDF bytes には検査結果を混ぜない。
- 自動修正は実装しない。既存の選択、グループ化、編集機能へ誘導する。
- 検査範囲は `現在ページ` と `全ページ` から選択できる。
- 全ページ検査は、現時点で `document.pages` に保持されている抽出済みページだけを対象とし、未ロードページを強制ロードしない。
- IME 辞書検知は使用しない。

## 3. 検査カテゴリ

| カテゴリ | 表示名 | 概要 | 重要度 |
|---|---|---|---|
| `character_fragmentation` | BB分断 | 1文字BBが連続している、英字/数字/カタカナ/漢字が細切れ | warning |
| `reading_order_anomaly` | 読み順異常 | 座標上近いのに order が離れている、order 隣接なのに座標が遠い | warning |
| `sentence_fragmentation` | 結合候補 | 助詞、読点、接続語で終わるBBが次BBと近接している | info |
| `symbol_structure` | 記号構造 | 括弧/引用符の閉じ忘れ、行頭/行末の不自然な句読点や括弧 | warning |
| `isolated_block` | 孤立BB | 1文字、記号、句点、空白だけのBBが離れている | warning |
| `duplicate_block` | 重複BB | 同じ座標付近に同じテキストが重なっている | error |
| `bbox_anomaly` | BBサイズ異常 | 空テキストBB、極小/極大BB、文字数に対して不自然なサイズ | error |

`character_fragmentation` は 1文字BBが `3個以上` 連続した場合に検出する。2個連続は通常の分割として起こり得るため除外する。

## 4. データモデル

```ts
export type InspectionCategory =
  | "character_fragmentation"
  | "reading_order_anomaly"
  | "sentence_fragmentation"
  | "symbol_structure"
  | "isolated_block"
  | "duplicate_block"
  | "bbox_anomaly";

export type InspectionSeverity = "error" | "warning" | "info";

export interface InspectionIssue {
  id: string;
  pageIndex: number;
  category: InspectionCategory;
  severity: InspectionSeverity;
  title: string;
  message: string;
  blockIds: string[];
  bbox: BoundingBox;
  text: string;
  suggestion?: string;
  ignored: boolean;
}
```

## 5. 処理フロー

```text
ユーザーが「確認」を押す
  ↓
選択範囲（現在ページ / 全ページ）の PageData.textBlocks を取得
  ↓
純粋関数の構造検査を実行
  ├─ BB分断
  ├─ 読み順異常
  ├─ 結合候補
  ├─ 記号構造
  ├─ 孤立BB
  ├─ 重複BB
  └─ BBサイズ異常
  ↓
InspectionIssue[] を inspectionStore に保存
  ↓
右ペインに一覧表示
  ↓
Canvas に bbox ハイライト表示
```

## 6. UI 方針

- 右ペインは `OCRテキスト` と `検査結果` のタブで切り替える。
- ツールバーの `検査` ドロップダウンで、検査範囲を `現在ページ` / `全ページ` から選択できる。
- 検査結果タブのヘッダーは件数バッジのみ表示し、範囲選択や実行ボタンは置かない。
- 結果行をクリックすると該当 BB を選択し、Canvas 上のハイライトへ移動する。
- `確認済み` はセッション内だけで保持する。
- 文言は誤字断定ではなく、`構造`、`結合候補`、`検査結果` として表示する。
- ステータスバーには `検査結果: N件` を表示する。

## 7. 受入条件

- 検査実行だけでは未保存状態にならない。
- IME や外部辞書を使わず検査できる。
- 新7カテゴリの検査結果が一覧と Canvas ハイライトに表示される。
- 結果クリックで対象 BB が選択される。
- 既存の開く、編集、グループ化、保存機能の挙動が変わらない。
