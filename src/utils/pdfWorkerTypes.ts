import type { PageData, PecoDocument } from '../types';

// Worker に渡す PageData は thumbnail を除いた構造（blob URL は Worker 不要）
export type SerializedPageData = Omit<PageData, 'thumbnail'>;

export interface SavePdfRequestData {
  originalPdfBytes: Uint8Array;
  documentState: Omit<PecoDocument, 'pages'> & { pages: Record<number, SerializedPageData> };
  fontBytes?: ArrayBuffer;
}

// main thread -> Worker (pdf.worker.ts) のメッセージ契約
export type SavePdfWorkerRequest =
  | { type: 'SAVE_PDF'; data: SavePdfRequestData };

// Worker (pdf.worker.ts) -> main thread のメッセージ契約
export type SavePdfWorkerResponse =
  | { type: 'SAVE_PDF_SUCCESS'; data: Uint8Array }
  | { type: 'ERROR'; message: string };
