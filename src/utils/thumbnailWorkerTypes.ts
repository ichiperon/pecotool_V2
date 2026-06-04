// Worker 境界のメッセージ型（discriminated union）。
// thumbnail.worker.ts / useThumbnailPanel.ts / ThumbnailWindow.tsx で共有。

export type ThumbnailWorkerRequest =
  | { type: 'LOAD_PDF'; url: string; bytes?: undefined; requestId?: number }
  | { type: 'LOAD_PDF'; bytes: ArrayBuffer; url?: undefined; requestId?: number }
  | { type: 'GENERATE_THUMBNAIL'; pageIndex: number; sourcePageIndex?: number; requestId?: number };

export type ThumbnailWorkerResponse =
  | { type: 'LOAD_COMPLETE'; numPages: number; workerPerfNow?: number; requestId?: number }
  | { type: 'LOAD_ERROR'; message: string; requestId?: number }
  | { type: 'THUMBNAIL_DONE'; pageIndex: number; bytes: Uint8Array; workerGenStart?: number; workerGenDone?: number; requestId?: number }
  | { type: 'THUMBNAIL_ERROR'; pageIndex: number; error?: string; requestId?: number };
