export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WritingMode = "horizontal" | "vertical";

/**
 * 湾曲ベースラインの定義 (issue #186)。
 * 存在しない場合は従来通り axis-aligned bbox に沿って描画する。
 *
 * - arc: 円弧。中心 + 半径 + 開始/終了角度で表現。ハンコの円周文字など
 * - polyline: 折れ線。複数の頂点を直線で繋ぐ。表表紙のタイトル等の段付きレイアウト
 *
 * angle は radian、Y 軸は PDF 座標系 (上向き正) ではなく viewport 座標系 (下向き正) で
 * 統一する (TextBlock.bbox と同じ)。
 */
export type CurveDefinition =
  | {
      type: "arc";
      center: { x: number; y: number };
      radius: number;
      startAngle: number;
      endAngle: number;
    }
  | {
      type: "polyline";
      points: Array<{ x: number; y: number }>;
    };

export interface TextBlock {
  id: string;
  text: string;
  originalText: string;
  bbox: BoundingBox;
  writingMode: WritingMode;
  order: number;
  isNew: boolean;
  isDirty: boolean;
  children?: string[]; // IDs of merged blocks
  /**
   * 湾曲ベースラインが定義されている場合、保存時に字ごとの Tm 行列で配置される。
   * 未定義時は従来通り bbox 単位の単一 drawText で配置 (後方互換)。
   */
  curve?: CurveDefinition;
}

export interface PageData {
  pageIndex: number;
  width: number;
  height: number;
  textBlocks: TextBlock[];
  isDirty: boolean;
  thumbnail: string | null; // Base64 or Blob URL
  /**
   * pdfTextExtractor.loadPage() によって実テキスト抽出が完了しているかどうか。
   * - true: loadPage が textBlocks を PDF から抽出した / 既存データを保持した (本物)
   * - false/undefined: usePageNavigation が viewport 寸法だけ入れたプレースホルダ、
   *   または clearOcrAllPages 等で textBlocks=[] を注入したダミー。
   *   OcrEditor など「textBlocks===[] が本当に空か未ロードか」を区別したい消費側が使う。
   */
  isTextExtracted?: boolean;
  /** ユーザー操作で OCR を明示的に空にしたページ。後続の抽出結果で上書きしない。 */
  ocrCleared?: boolean;
}

export interface PDFMetadata {
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
}

export interface PecoDocument {
  filePath: string;
  fileName: string;
  totalPages: number;
  metadata: PDFMetadata;
  pages: Map<number, PageData>;
  mtime?: number;
}

export interface UpdatePageAction {
  type: 'update_page';
  pageIndex: number;
  before: PageData;
  after: PageData;
}

/**
 * 複数ページに跨る単一の atomic な変更を表す Action。
 * issue #93 (Find & Replace): 全ページスコープでの一括置換を 1 回の undo で
 * まとめて巻き戻すために導入した。entries は変更があったページのみを記録する
 * (before/after 同値のページは含めない)。
 */
export interface UpdatePagesAction {
  type: 'update_pages';
  entries: Array<{
    pageIndex: number;
    before: PageData;
    after: PageData;
  }>;
}

export type Action = UpdatePageAction | UpdatePagesAction;

export interface OcrResultBlock {
  text: string;
  bbox: BoundingBox;
  writingMode: WritingMode;
  confidence: number;
}

export interface OcrResult {
  status: 'ok' | 'error';
  blocks: OcrResultBlock[];
  message?: string;
}
