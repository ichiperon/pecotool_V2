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
  /**
   * 明細欄フラグ。true のとき縦持ち展開の対象になる。
   * 省略時 false = 固定欄（従来挙動）。
   */
  isLineItem?: boolean;
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
 * 1 段（明細行）のセル値マップ。fieldId → セル値。
 * 固定欄も明細欄も同じ Map 内に格納する。
 */
export type ReportRow = Map<string, string>;

/**
 * ページ番号 → 段配列 の抽出結果マトリクス。
 * ページ番号は 1 始まりの実ページ番号。
 *
 * - 明細欄が無いテンプレートでは length=1 の配列（従来の 1 ページ 1 行と等価）。
 * - 明細欄ありでは各段が 1 エントリ。
 */
export type CellMatrix = Map<number, ReportRow[]>;

/**
 * ページごとの座標オフセット (scale=1.0 のページ座標系)。
 * 帳票の印刷ずれ補正のために欄 rect を平行移動する量を保持する。
 */
export interface PageOffset {
  dx: number;
  dy: number;
}

/** 未補正 (オフセットなし) を表す定数。Map に格納しない疎保持と対称的に使う。 */
export const ZERO_OFFSET: PageOffset = { dx: 0, dy: 0 };

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
