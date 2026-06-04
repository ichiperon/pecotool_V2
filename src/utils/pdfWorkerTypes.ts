import type { PageData, PecoDocument } from '../types';
import type { SaveDialogOptions } from '../hooks/useFileOperations';

// Worker に渡す PageData は thumbnail を除いた構造（blob URL は Worker 不要）
export type SerializedPageData = Omit<PageData, 'thumbnail'>;

/**
 * 保存リクエストのソース:
 * - bytes: main thread 側で既に Uint8Array を持っているケース（従来経路）
 * - url:   Worker 内で直接 fetch するケース（main thread OOM を回避）
 *
 * bytes / url のいずれか一方だけが必須。両方指定された場合は bytes を優先する。
 */
export type SavePdfSource =
  | { bytes: Uint8Array; url?: undefined }
  | { bytes?: undefined; url: string };

export type SavePdfRequestData = {
  documentState: Omit<PecoDocument, 'pages'> & { pages: Record<number, SerializedPageData> };
  fontBytes?: ArrayBuffer;
  fallbackFontBytes?: ArrayBuffer[];
  pageOrder?: number[];
  options?: SaveDialogOptions;
} & SavePdfSource;

export type SkippedPdfTextReason = 'control-character' | 'unsupported-font';

export interface SkippedPdfTextChar {
  char: string;
  codePoint: string;
  count: number;
  pages: number[];
  reason: SkippedPdfTextReason;
}

// main thread -> Worker (pdf.worker.ts) のメッセージ契約
export type SavePdfWorkerRequest =
  | { type: 'SAVE_PDF'; data: SavePdfRequestData };

// Worker (pdf.worker.ts) -> main thread のメッセージ契約
export type SavePdfWorkerResponse =
  | { type: 'SAVE_PDF_SUCCESS'; data: Uint8Array; skippedChars?: SkippedPdfTextChar[] }
  | { type: 'ERROR'; message: string };
