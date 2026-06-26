import { useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { parseOcrResponse } from "../lib/ocrAdapter";
import { computeCropRect, cropCanvasToPng, renderPageOffscreen } from "../lib/ocrCrop";
import { decideCellValue } from "../logic/cellValue";
import { effectiveRectForPage } from "../logic/pageOffset";
import { ZERO_OFFSET } from "../types/report";
import type { CellMatrix, PageOffset } from "../types/report";

/** OCR の描画スケール。値が大きいほど高精度だがメモリ消費が増える。 */
const REPORT_OCR_RENDER_SCALE = 3.0;

/** OCR の言語タグ */
const REPORT_OCR_LANGUAGE = "ja";

export interface ReportOcrProgress {
  /** 完了ページ数 */
  done: number;
  /** 全対象ページ数 */
  total: number;
}

export interface UseReportOcrReturn {
  isRunning: boolean;
  progress: ReportOcrProgress | null;
  /** 単一ページ再 OCR の対象ページ番号。実行中以外は null。 */
  reocrTarget: number | null;
  runOcr: () => Promise<void>;
  cancelOcr: () => void;
  /** 指定ページのみを再 OCR して setCellsForPage で部分更新する。 */
  runOcrForPage: (pageNum: number) => Promise<void>;
}

/**
 * 単一ページの OCR を実行し、fieldId → セル値の Map を返す内部ヘルパー。
 *
 * @param pdfDoc      pdfjs ドキュメントオブジェクト
 * @param pageNumber  対象ページ番号 (1 始まり)
 * @param fields      欄定義の配列
 * @param offset      ページ補正オフセット
 * @param isCancelled キャンセル判定コールバック
 * @returns           fieldId → セル値の Map、キャンセル時は null
 */
async function runOcrSinglePage(
  pdfDoc: Awaited<ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]>,
  pageNumber: number,
  fields: ReturnType<typeof useReportStore.getState>["template"]["fields"],
  offset: PageOffset,
  isCancelled: () => boolean
): Promise<Map<string, string> | null> {
  let canvas: HTMLCanvasElement | null = null;

  try {
    const rendered = await renderPageOffscreen(pdfDoc, pageNumber, REPORT_OCR_RENDER_SCALE);
    canvas = rendered.canvas;
    const pageWidth = rendered.pageWidth;

    const fieldMap = new Map<string, string>();

    for (const field of fields) {
      if (isCancelled()) return null;

      // オフセットを適用した補正済み rect でクロップ領域を計算する
      const effectiveRect = effectiveRectForPage(field.rect, offset);
      const crop = computeCropRect(
        effectiveRect,
        REPORT_OCR_RENDER_SCALE,
        canvas.width,
        canvas.height
      );

      if (crop.width <= 0 || crop.height <= 0) {
        fieldMap.set(field.id, "");
        continue;
      }

      const pngBytes = await cropCanvasToPng(canvas, crop);

      const body =
        pngBytes.byteOffset === 0 &&
        pngBytes.byteLength === pngBytes.buffer.byteLength
          ? pngBytes.buffer
          : pngBytes.slice().buffer;

      let raw: string;
      try {
        raw = await invoke<string>("run_report_ocr", body, {
          headers: {
            "x-render-scale": String(REPORT_OCR_RENDER_SCALE),
            "x-language-tag": REPORT_OCR_LANGUAGE,
            "x-page-width": String(pageWidth),
          },
        });
      } catch (e) {
        console.error(
          `[ReportOCR] invoke エラー (page=${pageNumber}, field=${field.id}):`,
          e
        );
        fieldMap.set(field.id, "");
        continue;
      }

      let blocks: ReturnType<typeof parseOcrResponse>;
      try {
        blocks = parseOcrResponse(raw);
      } catch (e) {
        console.error(
          `[ReportOCR] OCR レスポンスパースエラー (page=${pageNumber}, field=${field.id}):`,
          e
        );
        fieldMap.set(field.id, "");
        continue;
      }

      // クロップ＝この欄の領域なので、認識ブロックは全てこの欄に属する。
      // 座標再割り当てを挟まず decideCellValue で直接セル値を決める。
      fieldMap.set(field.id, decideCellValue(blocks));
    }

    return fieldMap;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * 全ページ × 全欄の OCR を実行し、cells を reportStore に格納する。
 *
 * 処理フロー:
 * 1. pdfjs でページをオフスクリーン canvas に render_scale 倍で描画
 * 2. 各欄 rect を effectiveRectForPage でオフセット適用後 computeCropRect でクロップ領域に変換
 * 3. cropCanvasToPng でクロップ PNG bytes を生成
 * 4. run_report_ocr コマンドに invoke（bytes を raw body として送信）
 * 5. parseOcrResponse で ReportBlock[] に変換
 * 6. decideCellValue でセル値を決定
 * 7. CellMatrix に蓄積後 setCells で store を更新
 *
 * キャンセル: cancelEpoch を比較してループを中断する。
 * 並列化: WindowsOCR のスレッド安全性懸念から MVP は直列実行。
 */
export function useReportOcr(): UseReportOcrReturn {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<ReportOcrProgress | null>(null);
  const [reocrTarget, setReocrTarget] = useState<number | null>(null);

  // キャンセル制御: epoch が変わったらループを中断する
  const epochRef = useRef(0);
  const cancelledRef = useRef(false);

  const runOcr = useCallback(async () => {
    const { template, setCells, pageOffsets } = useReportStore.getState();
    const { filePath, numPages } = usePdfStore.getState();

    if (!filePath || numPages === 0) return;
    if (template.fields.length === 0) return;

    // 新しい実行 epoch を発行
    const currentEpoch = ++epochRef.current;
    cancelledRef.current = false;

    setIsRunning(true);
    setProgress({ done: 0, total: numPages });

    const pdfjsLib = await import("pdfjs-dist");
    const { readFile } = await import("@tauri-apps/plugin-fs");

    const bytes = await readFile(filePath);
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

    const matrix: CellMatrix = new Map();

    const isCancelled = () =>
      cancelledRef.current || epochRef.current !== currentEpoch;

    try {
      for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
        if (isCancelled()) break;

        const pageNumber = pageIndex + 1;
        const offset = pageOffsets.get(pageNumber) ?? ZERO_OFFSET;

        try {
          const fieldMap = await runOcrSinglePage(
            pdfDoc,
            pageNumber,
            template.fields,
            offset,
            isCancelled
          );

          if (fieldMap === null) break; // キャンセル

          if (fieldMap.size > 0) {
            matrix.set(pageNumber, fieldMap);
          }
        } catch (e) {
          console.error(`[ReportOCR] ページ ${pageNumber} 処理エラー:`, e);
        }

        if (isCancelled()) break;

        setProgress({ done: pageIndex + 1, total: numPages });

        // UI スレッドを解放
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      pdfDoc.destroy().catch(() => {});
      setIsRunning(false);

      if (!cancelledRef.current && epochRef.current === currentEpoch) {
        setCells(matrix);
        setProgress(null);
      } else {
        setProgress(null);
      }
    }
  }, []);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const runOcrForPage = useCallback(async (pageNum: number) => {
    const { template, pageOffsets, setCellsForPage } = useReportStore.getState();
    const { filePath } = usePdfStore.getState();

    if (!filePath) return;
    if (template.fields.length === 0) return;

    // 全ページ OCR と同じ epoch を共有してキャンセルを相互に動作させる
    const currentEpoch = ++epochRef.current;
    cancelledRef.current = false;

    setIsRunning(true);
    setReocrTarget(pageNum);

    const pdfjsLib = await import("pdfjs-dist");
    const { readFile } = await import("@tauri-apps/plugin-fs");

    const isCancelled = () =>
      cancelledRef.current || epochRef.current !== currentEpoch;

    try {
      const bytes = await readFile(filePath);
      const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

      try {
        const offset = pageOffsets.get(pageNum) ?? ZERO_OFFSET;
        const fieldMap = await runOcrSinglePage(
          pdfDoc,
          pageNum,
          template.fields,
          offset,
          isCancelled
        );

        if (fieldMap !== null && !isCancelled()) {
          // 全置換せず対象ページのみ部分更新する
          setCellsForPage(pageNum, fieldMap);
        }
      } finally {
        pdfDoc.destroy().catch(() => {});
      }
    } catch (e) {
      console.error(`[ReportOCR] 単一ページ再 OCR エラー (page=${pageNum}):`, e);
    } finally {
      setIsRunning(false);
      setReocrTarget(null);
    }
  }, []);

  return { isRunning, progress, reocrTarget, runOcr, cancelOcr, runOcrForPage };
}
