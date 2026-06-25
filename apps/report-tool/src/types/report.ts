export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReportField {
  /** 欄の一意識別子 */
  id: string;
  /** 表示名（ヘッダ行に使用） */
  name: string;
  /** 欄の表示色（16進数または CSS カラー文字列） */
  color: string;
  /** ページ座標 (scale=1.0, y 軸は下方向) */
  rect: BoundingBox;
}

export interface ReportTemplate {
  fields: ReportField[];
}

/**
 * OCR または手入力で得た 1 つのテキスト片。
 * fieldId は assignBlocksToFields によって設定される。
 */
export interface ReportBlock {
  text: string;
  bbox: BoundingBox;
  fieldId: string | null;
  /** 手動入力ブロックの場合 true */
  isManual?: boolean;
  /** OCR 信頼度 (0.0〜1.0)。手入力時は未定義 */
  confidence?: number;
}

/**
 * ページ番号 → (fieldId → セル値) の抽出結果マトリクス。
 * ページ番号は 1 始まりの実ページ番号。
 */
export type CellMatrix = Map<number, Map<string, string>>;

export interface CsvOptions {
  /** 元ファイル名列を先頭に含めるか */
  includeFileName: boolean;
  /** ページ番号列を先頭側に含めるか */
  includePageNumber: boolean;
  /** 空セルの出力文字（既定: ""） */
  emptyValue: string;
  /** 数値正規化（normalizeNumeric）を各セルに適用するか */
  normalizeNumbers: boolean;
}
