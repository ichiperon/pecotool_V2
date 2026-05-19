export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WritingMode = "horizontal" | "vertical";

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
