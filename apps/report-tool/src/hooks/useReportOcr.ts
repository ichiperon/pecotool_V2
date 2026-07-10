import { useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportStore } from "../store/reportStore";
import type { ConfidenceMatrix, EditedMatrix } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { parseOcrResponse } from "../lib/ocrAdapter";
import { computeCropRect, cropCanvasToPng, renderPageOffscreen } from "../lib/ocrCrop";
import { decideCellValue, decideCellConfidence, clusterBlocksToRows } from "../logic/cellValue";
import { effectiveRectForPage } from "../logic/pageOffset";
import { ZERO_OFFSET } from "../types/report";
import type { CellMatrix, PageOffset, ReportField, ReportRow } from "../types/report";

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
  /** 直近の全ページ OCR で処理エラーになったページ番号（昇順）。エラーなし・未実行時は空配列。 */
  failedPages: number[];
  /**
   * 直近の全ページ OCR で、基準ページ（最初に処理成功したページ）と scale=1 の
   * ページ寸法が異なったページ番号（昇順）。用紙サイズ・向きの混在 PDF では
   * 欄テンプレートが内容とずれて空振りしうるため、警告表示に使う（計画書 §7.2 の
   * 「rotation 混在は MVP 対象外＝警告」の実装）。混在なし・未実行時は空配列。
   */
  layoutMismatchPages: number[];
  /**
   * レイアウト混在判定の基準ページ番号（最初に処理成功したページ。通常は 1 だが、
   * ページ 1 が処理エラーのときはずれる）。未実行・全ページ失敗時は null。
   * 警告文言で「どのページと比べて違うのか」を正確に示すために公開する。
   */
  layoutBasePage: number | null;
  /**
   * OCR エンジン自体が動いていない疑い（最初に処理したページで全欄の invoke が失敗）。
   * per-field の invoke 失敗は空文字＋console.error で握りつぶされるため、
   * 言語パック未導入等では「全セル空のまま正常終了に見える」事故になる（UXレビュー指摘）。
   * true のとき残ページの実行は中断され、既存 cells は上書きされない。
   */
  engineError: boolean;
  /**
   * 再OCR時に手修正済みセル（edited フラグ）の値を保持するか（既定 true）。
   * 50ページ手直しした後の「欄を1本足して再実行」で全修正が消える事故を防ぐ。
   */
  preserveEdited: boolean;
  setPreserveEdited: (value: boolean) => void;
  runOcr: () => Promise<void>;
  cancelOcr: () => void;
  /** 指定ページのみを再 OCR して setCellsForPage で部分更新する。 */
  runOcrForPage: (pageNum: number) => Promise<void>;
}

/** runOcrSinglePage の戻り値: セル値・信頼度の両段配列と scale=1 ページ寸法。 */
interface OcrSinglePageResult {
  rows: ReportRow[];
  confRows: Array<Map<string, number>>;
  pageWidth: number;
  pageHeight: number;
  /** このページで run_report_ocr invoke を試行した欄数（クロップ0件の欄は含まない） */
  invokeAttempts: number;
  /** invoke が例外になった欄数。attempts と一致＝ページ全欄失敗（エンジン死亡疑い） */
  invokeFailures: number;
}

/**
 * ページ寸法の一致判定の許容誤差 (pt)。同一用紙でも浮動小数の端数が出ることが
 * あるため、1pt 未満の差は同一レイアウトとみなす。
 */
const PAGE_DIMENSION_TOLERANCE = 1;

/**
 * 明細欄（isLineItem）の値配列を代表欄の段数 rowCount にそろえる。
 *
 * - 過不足なし: そのまま返す
 * - 不足: 末尾を空文字で埋める
 * - 超過: rowCount-1 段目までそのまま採用し、あふれた分は最終段へ改行(\n)で連結する
 *   （黙って切り捨てると OCR 結果を失うため、視認・復元可能な形で残す）
 *
 * @param values   その欄の段ごとの値配列（clusterBlocksToRows の戻り値）
 * @param rowCount 代表明細欄の段数（そろえたい段数）
 */
function alignValuesToRowCount(values: string[], rowCount: number): string[] {
  if (values.length <= rowCount) {
    return [...values, ...Array(rowCount - values.length).fill("")];
  }
  const head = values.slice(0, rowCount - 1);
  const overflow = values.slice(rowCount - 1).join("\n");
  return [...head, overflow];
}

/**
 * 欄ごとの値配列（valuesByField）から段配列（ReportRow[]）を組み立てる。
 *
 * 段数の基準: 「代表明細欄＝最初の isLineItem 欄」の段数 N に全列をそろえる。
 * - 固定欄（isLineItem=false）: rows[0] にのみ値を集約する。rows[1..] は当該欄を
 *   持たない（templateCsv は固定欄を常に rows[0] から読むため無関係、UI は
 *   〃表示で対応する）。
 * - 明細欄（isLineItem=true）: alignValuesToRowCount で N 段にそろえて各段に格納する。
 * - isLineItem 欄が 1 つも無い場合は従来どおり 1 段のみを返す（回帰なし）。
 *
 * @param fields         欄定義の配列（template.fields の順序）
 * @param valuesByField  fieldId → 段ごとの値配列
 */
function buildRowsFromFieldValues(
  fields: ReportField[],
  valuesByField: Map<string, string[]>
): ReportRow[] {
  const lineItemFields = fields.filter((f) => f.isLineItem === true);

  if (lineItemFields.length === 0) {
    // 明細欄なし: 従来どおり 1 段（バイト等価の回帰ゼロ経路）
    const row: ReportRow = new Map<string, string>();
    for (const field of fields) {
      row.set(field.id, valuesByField.get(field.id)?.[0] ?? "");
    }
    return [row];
  }

  // 代表明細欄 = 最初の isLineItem 欄。その段数 N（最低 1）に全列をそろえる。
  const representativeId = lineItemFields[0].id;
  const representativeValues = valuesByField.get(representativeId) ?? [];
  const rowCount = Math.max(1, representativeValues.length);

  const rows: ReportRow[] = Array.from({ length: rowCount }, () => new Map<string, string>());

  for (const field of fields) {
    const values = valuesByField.get(field.id) ?? [];

    if (field.isLineItem !== true) {
      // 固定欄: rows[0] にのみ集約する
      rows[0].set(field.id, values[0] ?? "");
      continue;
    }

    const aligned = alignValuesToRowCount(values, rowCount);
    aligned.forEach((value, i) => {
      rows[i].set(field.id, value);
    });
  }

  return rows;
}

/**
 * 欄ごとの confidence（decideCellConfidence の結果、欄クロップ全体の最小値）から
 * 段配列（confRows）を組み立てる。confidence は段ごとに再計算せず、欄単位の値を
 * 対象段全てへ複製する（rows の構造と対称: 固定欄は rows[0] のみ、明細欄は
 * 全 rowCount 段）。
 *
 * @param fields       欄定義の配列
 * @param confByField  fieldId → confidence（undefined は未設定＝confMap に入れない）
 * @param rowCount     buildRowsFromFieldValues が返した rows.length
 */
function buildConfRowsFromFieldConfidence(
  fields: ReportField[],
  confByField: Map<string, number>,
  rowCount: number
): Array<Map<string, number>> {
  const confRows: Array<Map<string, number>> = Array.from(
    { length: rowCount },
    () => new Map<string, number>()
  );

  for (const field of fields) {
    const conf = confByField.get(field.id);
    if (conf === undefined) continue;

    if (field.isLineItem !== true) {
      confRows[0].set(field.id, conf);
      continue;
    }

    for (let i = 0; i < rowCount; i++) {
      confRows[i].set(field.id, conf);
    }
  }

  return confRows;
}

/**
 * 手修正保持: 新しい OCR 結果（matrix/confMatrix・コミット前の作業用オブジェクト）へ、
 * 前回の手修正セル値を書き戻す。保持したセルの confidence は落とし（値は人が保証）、
 * 保持できた edited フラグの集合を返す（コミット後に store へ再設定する）。
 *
 * 段構造が変わった場合の制限: 新結果に同じ rowIndex が存在するセルだけ保持する
 * （段数が減った末尾の手修正は保持先が無いため失われる）。
 */
function applyEditedPreservation(
  matrix: CellMatrix,
  confMatrix: ConfidenceMatrix,
  prevCells: CellMatrix,
  prevEdited: EditedMatrix
): EditedMatrix {
  const preserved: EditedMatrix = new Map();

  for (const [pageNum, editedRows] of prevEdited) {
    const newRows = matrix.get(pageNum);
    if (!newRows) continue; // 失敗・除外・消滅ページは保持先なし

    editedRows.forEach((fieldIds, rowIndex) => {
      if (fieldIds.size === 0 || rowIndex >= newRows.length) return;
      for (const fieldId of fieldIds) {
        const prevValue = prevCells.get(pageNum)?.[rowIndex]?.get(fieldId);
        if (prevValue === undefined) continue;
        newRows[rowIndex].set(fieldId, prevValue);
        confMatrix.get(pageNum)?.[rowIndex]?.delete(fieldId);

        let pageRows = preserved.get(pageNum);
        if (!pageRows) {
          pageRows = [];
          preserved.set(pageNum, pageRows);
        }
        while (pageRows.length <= rowIndex) pageRows.push(new Set<string>());
        pageRows[rowIndex].add(fieldId);
      }
    });
  }

  return preserved;
}

/**
 * 単一ページの OCR を実行し、段配列（ReportRow[]）と信頼度段配列を返す内部ヘルパー。
 *
 * isLineItem=true の欄は clusterBlocksToRows で複数段に分割し、代表明細欄（最初の
 * isLineItem 欄）の段数にそろえる。isLineItem=false の欄は従来どおり 1 値に集約し
 * rows[0] にのみ格納する。
 *
 * @param pdfDoc      pdfjs ドキュメントオブジェクト
 * @param pageNumber  対象ページ番号 (1 始まり)
 * @param fields      欄定義の配列
 * @param offset      ページ補正オフセット
 * @param isCancelled キャンセル判定コールバック
 * @returns           段配列と信頼度段配列のペア、キャンセル時は null
 */
async function runOcrSinglePage(
  pdfDoc: Awaited<ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]>,
  pageNumber: number,
  fields: ReportField[],
  offset: PageOffset,
  isCancelled: () => boolean,
  userRotation: number = 0
): Promise<OcrSinglePageResult | null> {
  let canvas: HTMLCanvasElement | null = null;

  try {
    // 表示側と同じ回転で描画する（欄 rect は回転後の座標空間で定義されている）
    const rendered = await renderPageOffscreen(
      pdfDoc,
      pageNumber,
      REPORT_OCR_RENDER_SCALE,
      userRotation
    );
    canvas = rendered.canvas;
    const pageWidth = rendered.pageWidth;

    // フィールドごとの段別値配列（固定欄は要素数1、明細欄はクラスタ数分）と
    // 欄単位の confidence を集める。段配列への組み立ては全欄処理後にまとめて行う。
    const valuesByField = new Map<string, string[]>();
    const confByField = new Map<string, number>();
    let invokeAttempts = 0;
    let invokeFailures = 0;

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
        valuesByField.set(field.id, field.isLineItem === true ? [] : [""]);
        continue;
      }

      const pngBytes = await cropCanvasToPng(canvas, crop);

      const body =
        pngBytes.byteOffset === 0 &&
        pngBytes.byteLength === pngBytes.buffer.byteLength
          ? pngBytes.buffer
          : pngBytes.slice().buffer;

      let raw: string;
      invokeAttempts++;
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
        invokeFailures++;
        valuesByField.set(field.id, field.isLineItem === true ? [] : [""]);
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
        valuesByField.set(field.id, field.isLineItem === true ? [] : [""]);
        continue;
      }

      // クロップ＝この欄の領域なので、認識ブロックは全てこの欄に属する。
      // 座標再割り当てを挟まず decideCellValue / clusterBlocksToRows で直接値を決める。
      if (field.isLineItem === true) {
        valuesByField.set(field.id, clusterBlocksToRows(blocks));
      } else {
        valuesByField.set(field.id, [decideCellValue(blocks)]);
      }

      // confidence: ブロック群の最小値を欄単位で記録する（段では分割しない）
      const conf = decideCellConfidence(blocks);
      if (conf !== undefined) {
        confByField.set(field.id, conf);
      }
    }

    const rows = buildRowsFromFieldValues(fields, valuesByField);
    const confRows = buildConfRowsFromFieldConfidence(fields, confByField, rows.length);

    return {
      rows,
      confRows,
      pageWidth,
      pageHeight: rendered.pageHeight,
      invokeAttempts,
      invokeFailures,
    };
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
  // failedPages/layoutMismatchPages/layoutBasePage は #447 (PCT-211) で reportStore へ
  // 移した。以前はここの useState だったため、セッション復元で store 側の cells 等が
  // 復元されても診断状態だけ空のまま残り、CSV から失敗ページが無言欠落していた。
  // 読み取りは reactive selector（再描画のため）、書き込みは各処理内で
  // useReportStore.getState() から取得する（既存の setCells 等と同じパターン）。
  const failedPages = useReportStore((s) => s.failedPages);
  const layoutMismatchPages = useReportStore((s) => s.layoutMismatchPages);
  const layoutBasePage = useReportStore((s) => s.layoutBasePage);
  const [engineError, setEngineError] = useState(false);
  const [preserveEdited, setPreserveEditedState] = useState(true);
  // runOcr/runOcrForPage は useCallback([]) のため state を閉じ込めない。ref 経由で読む
  const preserveEditedRef = useRef(true);
  const setPreserveEdited = useCallback((value: boolean) => {
    preserveEditedRef.current = value;
    setPreserveEditedState(value);
  }, []);

  // キャンセル制御: epoch が変わったらループを中断する
  const epochRef = useRef(0);
  const cancelledRef = useRef(false);

  const runOcr = useCallback(async () => {
    const {
      template,
      setCells,
      setConfidences,
      pageOffsets,
      excludedPages,
      cells: prevCells,
      edited: prevEdited,
      setFailedPages,
      setLayoutMismatchPages,
      setLayoutBasePage,
    } = useReportStore.getState();
    // rotation は実行開始時に1回だけ読む（実行中に変わっても途中から混ざらない）
    const { filePath, numPages, rotation } = usePdfStore.getState();

    if (!filePath || numPages === 0) return;
    if (template.fields.length === 0) return;

    // 新しい実行 epoch を発行
    const currentEpoch = ++epochRef.current;
    cancelledRef.current = false;

    setIsRunning(true);
    setProgress({ done: 0, total: numPages });
    setEngineError(false);
    // failedPages / layoutMismatchPages / layoutBasePage はここでリセットしない:
    // エンジン死亡等で中断した場合は cells が保持されるため、対応する警告も
    // 保持しないと「データは古いのに警告だけ消える」非対称になる（レビュー指摘）。
    // 成功コミット時に finally 側でまとめて置換する。

    const matrix: CellMatrix = new Map();
    const confMatrix: ConfidenceMatrix = new Map();
    const failed: number[] = [];
    const mismatched: number[] = [];
    // レイアウト混在検出の基準（最初に処理成功したページの scale=1 寸法とページ番号）
    let baseDims: { width: number; height: number; pageNumber: number } | null = null;
    // エンジン死亡検知: この実行でまだ1欄も invoke 成功していないか
    let anyInvokeSucceeded = false;
    let engineDead = false;

    const isCancelled = () =>
      cancelledRef.current || epochRef.current !== currentEpoch;

    let pdfDoc: Awaited<ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]> | null =
      null;
    // PDF 読み込み自体が失敗した場合は matrix が空のまま finally に落ちる。
    // 既存の cells/confidences を空 Map で上書きしないようフラグで区別する。
    let loadFailed = false;

    try {
      // readFile/getDocument も try 内で実行し、ここで throw しても
      // finally で isRunning を確実に false へ戻す（読み込み失敗時のボタン永久 disable 防止）。
      const pdfjsLib = await import("pdfjs-dist");
      const { readFile } = await import("@tauri-apps/plugin-fs");

      const bytes = await readFile(filePath);
      pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

      for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
        if (isCancelled()) break;

        const pageNumber = pageIndex + 1;

        // 除外ページ（白紙・送付状等）は OCR をスキップする。matrix に載らないため
        // CSV にも出ない。failed/mismatch の判定対象にもしない。
        // excludedPages は rotation と同様、実行開始時のスナップショット
        //（実行中のトグルはその回に反映しない。CSV 側フィルタが最終防衛線）。
        if (excludedPages.has(pageNumber)) {
          setProgress({ done: pageIndex + 1, total: numPages });
          continue;
        }

        const offset = pageOffsets.get(pageNumber) ?? ZERO_OFFSET;

        try {
          const result = await runOcrSinglePage(
            pdfDoc,
            pageNumber,
            template.fields,
            offset,
            isCancelled,
            rotation
          );

          if (result === null) break; // キャンセル

          const { rows, confRows, pageWidth, pageHeight, invokeAttempts, invokeFailures } =
            result;

          const allInvokesFailed = invokeAttempts > 0 && invokeFailures === invokeAttempts;

          // エンジン死亡検知: まだ1欄も成功していない状態でページ全欄の invoke が
          // 失敗＝言語パック未導入等でエンジン自体が動いていない疑い。残ページを
          // 回しても全滅するだけなので即中断し、既存 cells を空で上書きしない。
          if (allInvokesFailed && !anyInvokeSucceeded) {
            engineDead = true;
            break;
          }
          if (invokeAttempts > invokeFailures) {
            anyInvokeSucceeded = true;
          }

          // ページ内全欄の invoke 失敗（エンジンは生きているが、このページだけ全滅）は
          // 「全欄空の行」として黙って CSV に載せず、処理失敗ページへ昇格する
          if (allInvokesFailed) {
            failed.push(pageNumber);
            setProgress({ done: pageIndex + 1, total: numPages });
            await new Promise((resolve) => setTimeout(resolve, 0));
            continue;
          }

          // 用紙サイズ・向きの混在検出: 基準ページと寸法が異なるページは
          // 欄テンプレートが内容とずれて空振りしうるため警告対象に積む（§7.2）
          if (baseDims === null) {
            baseDims = { width: pageWidth, height: pageHeight, pageNumber };
          } else if (
            Math.abs(pageWidth - baseDims.width) > PAGE_DIMENSION_TOLERANCE ||
            Math.abs(pageHeight - baseDims.height) > PAGE_DIMENSION_TOLERANCE
          ) {
            mismatched.push(pageNumber);
          }

          if (rows.length > 0 && rows.some((r) => r.size > 0)) {
            matrix.set(pageNumber, rows);
          }
          if (confRows.some((m) => m.size > 0)) {
            confMatrix.set(pageNumber, confRows);
          }
        } catch (e) {
          console.error(`[ReportOCR] ページ ${pageNumber} 処理エラー:`, e);
          failed.push(pageNumber);
        }

        if (isCancelled()) break;

        setProgress({ done: pageIndex + 1, total: numPages });

        // UI スレッドを解放
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      console.error("[ReportOCR] PDF 読み込みエラー:", e);
      loadFailed = true;
    } finally {
      pdfDoc?.destroy().catch(() => {});
      setIsRunning(false);

      if (
        !cancelledRef.current &&
        epochRef.current === currentEpoch &&
        !loadFailed &&
        !engineDead
      ) {
        // 手修正保持: コミット前の作業用 matrix/confMatrix に前回の手修正値を書き戻す
        const preservedEdited = preserveEditedRef.current
          ? applyEditedPreservation(matrix, confMatrix, prevCells, prevEdited)
          : new Map();
        setCells(matrix);
        // setCells が confidences をクリアするので後から setConfidences を呼ぶ
        setConfidences(confMatrix);
        // setCells は edited もクリアするため、保持できたフラグを再設定する
        if (preservedEdited.size > 0) {
          useReportStore.setState({ edited: preservedEdited });
        }
        setProgress(null);
        setFailedPages(failed);
        setLayoutMismatchPages(mismatched);
        setLayoutBasePage(baseDims?.pageNumber ?? null);
      } else {
        setProgress(null);
        // エンジン死亡時は既存 cells を保持したままエラーだけ可視化する
        if (engineDead && !cancelledRef.current && epochRef.current === currentEpoch) {
          setEngineError(true);
        }
      }
    }
  }, []);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const runOcrForPage = useCallback(async (pageNum: number) => {
    const { template, pageOffsets, setCellsForPage, setConfidencesForPage, setFailedPages } =
      useReportStore.getState();
    const { filePath, rotation } = usePdfStore.getState();
    const { cells: prevCellsForPage, edited: prevEditedForPage } = useReportStore.getState();

    if (!filePath) return;
    if (template.fields.length === 0) return;
    // 除外ページは再OCR対象外。UI 側のボタンは disabled になるが（ConfirmPdfPane）、
    // ここでも防御して silent な上書きを防ぐ
    if (useReportStore.getState().excludedPages.has(pageNum)) return;

    // 全ページ OCR と同じ epoch を共有してキャンセルを相互に動作させる
    const currentEpoch = ++epochRef.current;
    cancelledRef.current = false;

    setIsRunning(true);
    setReocrTarget(pageNum);

    const isCancelled = () =>
      cancelledRef.current || epochRef.current !== currentEpoch;

    try {
      // pdfjs-dist / plugin-fs の動的 import と readFile/getDocument も try 内で実行し、
      // ここで throw しても finally で isRunning を確実に false へ戻す
      // （runOcr と対称化。読み込み失敗時のボタン永久 disable 防止）。
      const pdfjsLib = await import("pdfjs-dist");
      const { readFile } = await import("@tauri-apps/plugin-fs");

      const bytes = await readFile(filePath);
      const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

      try {
        const offset = pageOffsets.get(pageNum) ?? ZERO_OFFSET;
        const result = await runOcrSinglePage(
          pdfDoc,
          pageNum,
          template.fields,
          offset,
          isCancelled,
          rotation
        );

        if (result !== null && !isCancelled()) {
          const { rows, confRows, invokeAttempts, invokeFailures } = result;

          // 全欄 invoke 失敗（エンジン停止疑い）は書き込まない。空行で既存データを
          // 上書きすると、再OCR取り込みは undo 境界（履歴クリア）のため Ctrl+Z でも
          // 戻せない（レビュー指摘 MAJOR-2・全ページ実行の engineDead ガードと対称化）。
          if (invokeAttempts > 0 && invokeFailures === invokeAttempts) {
            throw new Error(
              "全欄の OCR 呼び出しに失敗しました（OCR エンジン停止の可能性）。既存の値は変更していません"
            );
          }

          // 手修正保持（対象ページのみ）: 単一ページの Matrix に見立てて共通ヘルパーを使う
          let preservedForPage: EditedMatrix = new Map();
          if (preserveEditedRef.current) {
            const pageMatrix: CellMatrix = new Map([[pageNum, rows]]);
            const pageConf: ConfidenceMatrix = new Map([[pageNum, confRows]]);
            const prevEditedOnlyPage: EditedMatrix = new Map();
            const prevRows = prevEditedForPage.get(pageNum);
            if (prevRows) prevEditedOnlyPage.set(pageNum, prevRows);
            preservedForPage = applyEditedPreservation(
              pageMatrix,
              pageConf,
              prevCellsForPage,
              prevEditedOnlyPage
            );
          }

          // 全置換せず対象ページのみ部分更新する（複数段対応: rows.length 段）
          setCellsForPage(pageNum, rows);
          // setCellsForPage が confidences をクリアするので後から setConfidencesForPage を呼ぶ
          setConfidencesForPage(pageNum, confRows);
          // setCellsForPage は対象ページの edited をクリアするため、保持分を再設定
          const preservedRows = preservedForPage.get(pageNum);
          if (preservedRows && preservedRows.length > 0) {
            const nextEdited = new Map(useReportStore.getState().edited);
            nextEdited.set(pageNum, preservedRows);
            useReportStore.setState({ edited: nextEdited });
          }
          // 再OCRが成功したページは「OCR失敗」警告から外す。残すとステップ③の
          // バナーと出力前ゲートが事実と逆の警告を出し続ける（レビュー指摘 MAJOR-1）。
          setFailedPages((prev) => prev.filter((p) => p !== pageNum));
        }
      } finally {
        pdfDoc.destroy().catch(() => {});
      }
    } catch (e) {
      console.error(`[ReportOCR] 単一ページ再 OCR エラー (page=${pageNum}):`, e);
      // ConfirmLayout の reocrError（インラインエラー＋再試行ボタン）へ伝播させる。
      // 握りつぶすと再OCR失敗が無反応に見える（従来はここで握りつぶしており
      // reocrError 表示が実質デッドコードだった）。
      throw e;
    } finally {
      setIsRunning(false);
      setReocrTarget(null);
    }
  }, []);

  return {
    isRunning,
    progress,
    reocrTarget,
    failedPages,
    layoutMismatchPages,
    layoutBasePage,
    engineError,
    preserveEdited,
    setPreserveEdited,
    runOcr,
    cancelOcr,
    runOcrForPage,
  };
}
