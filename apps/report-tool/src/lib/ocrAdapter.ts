import type { ReportBlock } from "../types/report";

/**
 * run_report_ocr コマンドが返す JSON の 1 ブロック形式。
 * IPC 契約に従い、bbox は render_scale で割り戻し済みの page 座標で届く。
 */
interface RawOcrBlock {
  text: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  writingMode?: string;
  confidence?: number;
}

/**
 * run_report_ocr コマンドが返す JSON のトップレベル形式。
 */
interface RawOcrResponse {
  status: string;
  blocks?: RawOcrBlock[];
  message?: string;
}

export class OcrAdapterError extends Error {
  constructor(
    message: string,
    public readonly raw?: string
  ) {
    super(message);
    this.name = "OcrAdapterError";
  }
}

/**
 * run_report_ocr の JSON 文字列レスポンスを ReportBlock[] に変換する。
 *
 * - status が "ok" 以外の場合は OcrAdapterError を throw する。
 * - JSON パース失敗の場合も OcrAdapterError を throw する。
 * - blocks が undefined または空の場合は空配列を返す。
 * - fieldId はこの層では null に設定する（座標割り当ては呼び出し側で行う）。
 *
 * @param jsonString run_report_ocr から返ってきた生の JSON 文字列
 * @returns ReportBlock[] （fieldId=null）
 * @throws OcrAdapterError JSON 不正または status != "ok" の場合
 */
export function parseOcrResponse(jsonString: string): ReportBlock[] {
  let parsed: RawOcrResponse;
  try {
    parsed = JSON.parse(jsonString) as RawOcrResponse;
  } catch (e) {
    throw new OcrAdapterError(`OCR レスポンスの JSON パースに失敗: ${e}`, jsonString);
  }

  if (parsed.status !== "ok") {
    const msg = parsed.message ?? `status="${parsed.status}"`;
    throw new OcrAdapterError(`OCR エラー: ${msg}`, jsonString);
  }

  const blocks = parsed.blocks ?? [];
  return blocks.map((b): ReportBlock => ({
    text: b.text,
    bbox: {
      x: b.bbox.x,
      y: b.bbox.y,
      width: b.bbox.width,
      height: b.bbox.height,
    },
    fieldId: null,
    confidence: b.confidence,
  }));
}
