// Worker 境界のメッセージ型（discriminated union）。
// thumbnail.worker.ts / useThumbnailPanel.ts / ThumbnailWindow.tsx で共有。

export type ThumbnailWorkerRequest =
  | { type: 'LOAD_PDF'; url: string; bytes?: undefined }
  | { type: 'LOAD_PDF'; bytes: ArrayBuffer; url?: undefined }
  | { type: 'GENERATE_THUMBNAIL'; pageIndex: number };

export type ThumbnailWorkerResponse =
  | { type: 'LOAD_COMPLETE'; numPages: number; workerPerfNow?: number }
  | { type: 'LOAD_ERROR'; message: string }
  | { type: 'THUMBNAIL_DONE'; pageIndex: number; bytes: Uint8Array; workerGenStart?: number; workerGenDone?: number }
  | { type: 'THUMBNAIL_ERROR'; pageIndex: number; error?: string };
