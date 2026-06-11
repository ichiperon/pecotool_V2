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
  /**
   * OCR 信頼度 (0..1)。Windows OCR の OcrResultBlock.confidence に由来する。
   * undefined の場合は legacy 扱いとして色付けしない (#192)。
   */
  confidence?: number;
}

export interface PageData {
  pageIndex: number;
  /**
   * PCT-104 (A-lite): ページの安定ID。値は `"src:" + 初期 source index`。
   * move / delete / rotate / undo / redo を通じて不変。
   * IDB temporary_changes キーの `filePath:pageId` 化（段階2）で rename 同期を全廃するための基盤。
   * optional: 段階0 は型宣言のみで既存エントリには存在しない。
   */
  pageId?: string;
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
  /**
   * issue #207: ユーザー操作によるページ回転角度 (時計回り、度数)。
   * 未設定は 0 (回転なし) として扱う。
   * pdfSaver はこの値を使って pdf-lib の page.setRotation() を呼ぶ。
   */
  rotation?: 0 | 90 | 180 | 270;
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
  // pageOrder is intentionally removed from PecoDocument (#209).
  // The canonical page order is stored in pecoStore.pageOrder.
  // Callers that need pageOrder must read from usePecoStore.getState().pageOrder.
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

/**
 * ページ削除操作を表す Action (issue #193)。
 * before: 削除前の pages Map (全ページ)、beforeOrder: 削除前の pageOrder。
 * after: 削除後の pages Map、afterOrder: 削除後の pageOrder。
 */
export interface DeletePagesAction {
  type: 'delete_pages';
  beforePages: Map<number, PageData>;
  afterPages: Map<number, PageData>;
  beforeOrder: number[];
  afterOrder: number[];
  beforeCurrentPageIndex: number;
  afterCurrentPageIndex: number;
  beforeTotalPages: number;
  afterTotalPages: number;
  /**
   * PCT-069 / PCT-104 (A-lite 段階2): 削除された displayIndex の配列。
   * redo 時に pageId 変換して deleteTemporaryPageKeys を呼ぶために記録する。後方互換のため optional。
   */
  deletedPageIndices?: number[];
}

/**
 * ページ並べ替え操作を表す Action (issue #193)。
 * PCT-104 (A-lite 段階3): renamedEntries は pageId 安定化により不要になったため削除。
 */
export interface ReorderPagesAction {
  type: 'reorder_pages';
  beforeOrder: number[];
  afterOrder: number[];
}

/**
 * ページ回転操作を表す Action (issue #207)。
 * changes: 変更があったページの pageIndex と回転前後の角度。
 */
export interface RotatePagesAction {
  type: 'rotate_pages';
  changes: Array<{ pageIndex: number; before: 0 | 90 | 180 | 270; after: 0 | 90 | 180 | 270 }>;
}

export type Action = UpdatePageAction | UpdatePagesAction | DeletePagesAction | ReorderPagesAction | RotatePagesAction;

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
