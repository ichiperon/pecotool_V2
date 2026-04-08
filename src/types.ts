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

export interface Action {
  type: 'update_page';
  pageIndex: number;
  before: PageData;
  after: PageData;
}

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
