import { useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { parseOcrResponse } from "../lib/ocrAdapter";
import { computeCropRect, cropCanvasToPng, renderPageOffscreen } from "../lib/ocrCrop";
import { decideCellValue } from "../logic/cellValue";
import type { CellMatrix } from "../types/report";

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
  runOcr: () => Promise<void>;
  cancelOcr: () => void;
}

/**
 * 全ページ × 全欄の OCR を実行し、cells を reportStore に格納する。
 *
 * 処理フロー:
 * 1. pdfjs でページをオフスクリーン canvas に render_scale 倍で描画
 * 2. 各欄 rect を computeCropRect でクロップ領域に変換
 * 3. cropCanvasToPng でクロップ PNG bytes を生成
 * 4. run_report_ocr コマンドに invoke（bytes を raw body として送信）
 * 5. parseOcrResponse で ReportBlock[] に変換
 * 6. assignBlocksToFields で fieldId を付与
 * 7. decideCellValue でセル値を決定
 * 8. CellMatrix に蓄積後 setCells で store を更新
 *
 * キャンセル: cancelEpoch を比較してループを中断する。
 * 並列化: WindowsOCR のスレッド安全性懸念から MVP は直列実行。
 */
export function useReportOcr(): UseReportOcrReturn {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<ReportOcrProgress | null>(null);

  // キャンセル制御: epoch が変わったらループを中断する
  const epochRef = useRef(0);
  const cancelledRef = useRef(false);

  const runOcr = useCallback(async () => {
    const { template, setCells } = useReportStore.getState();
    const { filePath, numPages } = usePdfStore.getState();

    if (!filePath || numPages === 0) return;
    if (template.fields.length === 0) return;

    // 新しい実行 epoch を発行
    const currentEpoch = ++epochRef.current;
    cancelledRef.current = false;

    setIsRunning(true);
    setProgress({ done: 0, total: numPages });

    // pdfjs-dist を動的インポート（コンポーネント外でも動作）
    const pdfjsLib = await import("pdfjs-dist");
    const { readFile } = await import("@tauri-apps/plugin-fs");

    // PDF を独立したドキュメントとして開く（共有 proxy を汚染しない）
    const bytes = await readFile(filePath);
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

    const matrix: CellMatrix = new Map();

    try {
      for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
        // キャンセルチェック
        if (cancelledRef.current || epochRef.current !== currentEpoch) break;

        const pageNumber = pageIndex + 1; // pdfjs は 1 始まり

        let canvas: HTMLCanvasElement | null = null;
        let pageWidth = 0;

        try {
          // ページをオフスクリーン canvas に描画
          const rendered = await renderPageOffscreen(pdfDoc, pageNumber, REPORT_OCR_RENDER_SCALE);
          canvas = rendered.canvas;
          pageWidth = rendered.pageWidth;

          const fields = useReportStore.getState().template.fields;
          // 各欄のクロップ画像を OCR し、その欄へ直接セル値を割り当てる。
          // クロップ画像は欄領域そのものを切り出すため、OCR が返す bbox は
          // クロップローカル座標（0 始まり）になる。assignRegionByCoord の
          // ような絶対 page 座標ベースの再割り当ては使えない（原点付近以外の
          // 欄が未割当になり全セルが空になる）。クロップ＝欄が 1:1 なので、
          // その欄のブロックは無条件にその欄へ属する（計画書 §7.2）。
          const fieldMap = new Map<string, string>();

          for (const field of fields) {
            if (cancelledRef.current || epochRef.current !== currentEpoch) break;

            // 欄 rect をクロップ矩形に変換
            const crop = computeCropRect(
              field.rect,
              REPORT_OCR_RENDER_SCALE,
              canvas.width,
              canvas.height
            );

            // クロップ領域が 0px なら OCR をスキップ（空セル扱い）
            if (crop.width <= 0 || crop.height <= 0) {
              fieldMap.set(field.id, "");
              continue;
            }

            // クロップ PNG を生成
            const pngBytes = await cropCanvasToPng(canvas, crop);

            // raw body として invoke（本体の useOcrEngine と同じ書式）
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

          // 処理したページは 1 ページ = 1 行として必ず記録する（§7.7）。
          // 全セルが空でも行は残し、後段の手入力補正に備える。
          if (fieldMap.size > 0) {
            // CellMatrix のキーは 1 始まりのページ番号
            matrix.set(pageNumber, fieldMap);
          }
        } catch (e) {
          console.error(`[ReportOCR] ページ ${pageNumber} 処理エラー:`, e);
        } finally {
          // canvas を解放
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
        }

        // キャンセルチェック
        if (cancelledRef.current || epochRef.current !== currentEpoch) break;

        setProgress({ done: pageIndex + 1, total: numPages });

        // UI スレッドを解放
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      pdfDoc.destroy().catch(() => {});
      setIsRunning(false);

      // キャンセルされていなければ cells を格納
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

  return { isRunning, progress, runOcr, cancelOcr };
}
