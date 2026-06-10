// Worker 境界のメッセージ型（discriminated union）。
// thumbnail.worker.ts / useThumbnailPanel.ts / ThumbnailWindow.tsx で共有。

export type ThumbnailWorkerRequest =
  | { type: 'LOAD_PDF'; url: string; bytes?: undefined; requestId?: number }
  | { type: 'LOAD_PDF'; bytes: ArrayBuffer; url?: undefined; requestId?: number }
  | { type: 'GENERATE_THUMBNAIL'; pageIndex: number; sourcePageIndex?: number; requestId?: number }
  // PCT-073: ファイルクローズ時に worker が保持する PDF リソース
  // （pdfDoc / 進行中の loadingTask）を明示解放する。応答なしの fire-and-forget。
  // 後続の LOAD_PDF は worker メッセージキューで CLOSE_PDF の後に処理され、
  // LOAD_PDF 側も冒頭で同じクリーンアップを再実行するため完了通知は不要。
  | { type: 'CLOSE_PDF' };

export type ThumbnailWorkerResponse =
  | { type: 'LOAD_COMPLETE'; numPages: number; workerPerfNow?: number; requestId?: number }
  | { type: 'LOAD_ERROR'; message: string; requestId?: number }
  | { type: 'THUMBNAIL_DONE'; pageIndex: number; bytes: Uint8Array; workerGenStart?: number; workerGenDone?: number; requestId?: number }
  | { type: 'THUMBNAIL_ERROR'; pageIndex: number; error?: string; requestId?: number };
