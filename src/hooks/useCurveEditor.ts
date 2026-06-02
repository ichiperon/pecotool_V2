/**
 * useCurveEditor フック (issue #218)
 *
 * PdfCanvas.tsx にインラインだった curve mode の state / ハンドラ群を抽出。
 * - curveClickPoints: 3 点クリック arc 作成の中間点収集
 * - curveHandleDragRef: handle drag の状態
 * - polylineDraftPoints / polylineDraftActive / polylineMousePosRef: polyline 作成 draft (#205)
 * - マウスイベントハンドラの curve 分岐ロジック
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { arcFromThreePoints, arcHandlePositions } from "../utils/arcFromThreePoints";
import { isCurveDefinition } from "../utils/curveDefinition";
import type { CurveDefinition, PageData, TextBlock } from "../types";

export interface UseCurveEditorParams {
  pageIndex: number;
  zoom: number;
  isCurveMode: boolean;
  selectedIds: Set<string>;
  currentTextBlocksById: Map<string, TextBlock>;
  getPageData: () => PageData | undefined;
  updatePageData: (pageIndex: number, partial: Partial<PageData>, pushUndo?: boolean) => void;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  renderOverlaysRef: React.RefObject<(() => void) | null>;
  overlayRafRef: React.MutableRefObject<number | null>;
}

export interface UseCurveEditorResult {
  curveClickPoints: Array<{ x: number; y: number }>;
  curveHandleDragRef: React.MutableRefObject<{ handleIndex: number; blockId: string } | null>;
  polylineDraftPoints: Array<{ x: number; y: number }>;
  polylineDraftActive: boolean;
  polylineMousePosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  lastDoubleClickTimeRef: React.MutableRefObject<number>;
  handleMouseDownCurve: (pos: { x: number; y: number }) => boolean;
  handleMouseMoveCurve: (pos: { x: number; y: number }) => boolean;
  handleMouseUpCurve: () => boolean;
  handleDoubleClickCurve: (pos: { x: number; y: number }) => boolean;
  hitTestCurveHandle: (pos: { x: number; y: number }) => { blockId: string; handleIndex: number } | null;
  canvasToViewport: (pos: { x: number; y: number }) => { x: number; y: number };
}

export function useCurveEditor(params: UseCurveEditorParams): UseCurveEditorResult {
  const {
    pageIndex,
    zoom,
    isCurveMode,
    selectedIds,
    currentTextBlocksById,
    getPageData,
    updatePageData,
    overlayCanvasRef,
    renderOverlaysRef,
    overlayRafRef,
  } = params;

  // ── Curve mode state (issue #189) ─────────────────────────────
  // 3 点クリックで arc を作成する際に収集する中間点（viewport 座標 / zoom 適用前）
  const [curveClickPoints, setCurveClickPoints] = useState<Array<{ x: number; y: number }>>([]);
  // handle drag: どの handle を掴んでいるか (0=始点 1=中点 2=終点)、null=非ドラッグ
  const curveHandleDragRef = useRef<{ handleIndex: number; blockId: string } | null>(null);

  // ── #205: Polyline 作成 draft state ───────────────────────────
  const [polylineDraftPoints, setPolylineDraftPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [polylineDraftActive, setPolylineDraftActive] = useState(false);
  // マウス現在位置 (canvas 座標) を ref で保持して preview 線に使う（再レンダ不要）
  const polylineMousePosRef = useRef<{ x: number; y: number } | null>(null);
  // ダブルクリック直後のシングルクリックイベントを抑制するためのタイムスタンプ ref
  const lastDoubleClickTimeRef = useRef<number>(0);

  /**
   * canvas 座標 (zoom 適用済み) → viewport 座標 (zoom 等倍) に戻す。
   * curveDefinition / arcFromThreePoints は zoom 非適用の viewport 座標で扱う。
   */
  const canvasToViewport = useCallback((pos: { x: number; y: number }) => {
    const scale = zoom / 100;
    return { x: pos.x / scale, y: pos.y / scale };
  }, [zoom]);

  /**
   * 選択中 BB の arc handle に pos が当たっているか確認し、
   * hit した handle index を返す。hit なし → null。
   */
  const hitTestCurveHandle = useCallback((pos: { x: number; y: number }): { blockId: string; handleIndex: number } | null => {
    if (!isCurveMode) return null;
    const scale = zoom / 100;
    const HIT_RADIUS = 10; // px

    for (const id of selectedIds) {
      const block = currentTextBlocksById.get(id);
      if (!block?.curve || !isCurveDefinition(block.curve)) continue;
      const curve = block.curve;

      const handles: Array<{ x: number; y: number }> =
        curve.type === "arc"
          ? arcHandlePositions(curve.center, curve.radius, curve.startAngle, curve.endAngle)
          : curve.points;

      for (let hi = 0; hi < handles.length; hi++) {
        const hx = handles[hi].x * scale;
        const hy = handles[hi].y * scale;
        const dist = Math.sqrt((pos.x - hx) ** 2 + (pos.y - hy) ** 2);
        if (dist <= HIT_RADIUS) {
          return { blockId: id, handleIndex: hi };
        }
      }
    }
    return null;
  }, [isCurveMode, zoom, selectedIds, currentTextBlocksById]);

  // #205: polyline draft 確定ヘルパー
  const confirmPolylineDraft = useCallback(() => {
    if (!polylineDraftActive || polylineDraftPoints.length < 2) return;
    const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
    if (!selectedId) return;
    const page = getPageData();
    if (page) {
      const newCurve: CurveDefinition = { type: "polyline", points: polylineDraftPoints };
      const newBlocks = page.textBlocks.map((b) =>
        b.id === selectedId ? { ...b, curve: newCurve, isDirty: true } : b,
      );
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, true);
    }
    setPolylineDraftPoints([]);
    setPolylineDraftActive(false);
    polylineMousePosRef.current = null;
  }, [polylineDraftActive, polylineDraftPoints, selectedIds, getPageData, updatePageData, pageIndex]);

  // #205: キーボードで Enter 確定 / Esc キャンセル
  useEffect(() => {
    if (!polylineDraftActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmPolylineDraft();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPolylineDraftPoints([]);
        setPolylineDraftActive(false);
        polylineMousePosRef.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [polylineDraftActive, confirmPolylineDraft]);

  /**
   * curve mode の mouseDown 処理。
   * 処理した場合は true を返す (PdfCanvas 側で return するため)。
   */
  const handleMouseDownCurve = useCallback((pos: { x: number; y: number }): boolean => {
    if (!isCurveMode || selectedIds.size !== 1) return false;
    const selectedId = Array.from(selectedIds)[0];

    // #205: polyline draft 中はシングルクリックで点を追加する
    // ダブルクリック直後の synthetic click を無視するため 300ms ガード
    if (polylineDraftActive) {
      const now = Date.now();
      if (now - lastDoubleClickTimeRef.current < 300) return true;
      const pdfPos = canvasToViewport(pos);
      setPolylineDraftPoints((prev) => [...prev, pdfPos]);
      return true;
    }

    // handle hit-test (既存 curve がある場合)
    const hit = hitTestCurveHandle(pos);
    if (hit) {
      curveHandleDragRef.current = { handleIndex: hit.handleIndex, blockId: hit.blockId };
      return true;
    }

    // 3 点クリック収集 (arc 作成)
    const pdfPos = canvasToViewport(pos);
    const newPoints = [...curveClickPoints, pdfPos];
    if (newPoints.length < 3) {
      setCurveClickPoints(newPoints);
      return true;
    }

    // 3 点目: arc を算出して TextBlock に set
    const [p1, p2, p3] = newPoints;
    const arc = arcFromThreePoints(p1, p2, p3);
    if (!arc) {
      // 3 点が直線上 → 収集をリセット
      setCurveClickPoints([]);
      return true;
    }

    // undoable で curve を書き込む
    const page = getPageData();
    if (page) {
      const newBlocks = page.textBlocks.map((b) =>
        b.id === selectedId ? { ...b, curve: arc as CurveDefinition, isDirty: true } : b,
      );
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, true);
    }
    setCurveClickPoints([]);
    return true;
  }, [isCurveMode, selectedIds, polylineDraftActive, hitTestCurveHandle, canvasToViewport, curveClickPoints, getPageData, updatePageData, pageIndex]);

  /**
   * curve mode の mouseMove 処理。
   * 処理した場合は true を返す。
   */
  const handleMouseMoveCurve = useCallback((pos: { x: number; y: number }): boolean => {
    // #205: polyline draft 中はマウス位置を ref に保持して preview 線を描画
    if (polylineDraftActive) {
      polylineMousePosRef.current = pos;
      // preview 再描画は RAF 経由でスケジュール
      if (renderOverlaysRef.current) {
        if (overlayRafRef.current) cancelAnimationFrame(overlayRafRef.current);
        overlayRafRef.current = requestAnimationFrame(() => {
          renderOverlaysRef.current?.();
          overlayRafRef.current = null;
        });
      }
      return true;
    }

    // curve handle drag 中: handle 位置を更新して curve を再算出
    if (curveHandleDragRef.current) {
      const { blockId, handleIndex } = curveHandleDragRef.current;
      const block = currentTextBlocksById.get(blockId);
      if (block?.curve && isCurveDefinition(block.curve)) {
        const pdfPos = canvasToViewport(pos);
        const curve = block.curve;

        let newCurve: CurveDefinition | null = null;
        if (curve.type === "arc") {
          // 3 ハンドル位置を取得して移動先を反映
          const handles = arcHandlePositions(curve.center, curve.radius, curve.startAngle, curve.endAngle);
          handles[handleIndex] = pdfPos;
          newCurve = arcFromThreePoints(handles[0], handles[1], handles[2]);
        } else if (curve.type === "polyline") {
          const newPoints = curve.points.map((p, i) => (i === handleIndex ? pdfPos : p));
          newCurve = { type: "polyline", points: newPoints };
        }

        if (newCurve) {
          const page = getPageData();
          if (page) {
            const newBlocks = page.textBlocks.map((b) =>
              b.id === blockId ? { ...b, curve: newCurve as CurveDefinition, isDirty: true } : b,
            );
            // drag 中は undoable=false で頻度を抑える。mouseUp で確定
            updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, false);
          }
        }
      }
      return true;
    }

    // cursor 更新 (isCurveMode のとき)
    if (isCurveMode) {
      const hit = hitTestCurveHandle(pos);
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.style.cursor = hit ? "pointer" : "crosshair";
      }
      return true;
    }

    return false;
  }, [polylineDraftActive, renderOverlaysRef, overlayRafRef, currentTextBlocksById, canvasToViewport, getPageData, updatePageData, pageIndex, isCurveMode, hitTestCurveHandle, overlayCanvasRef]);

  /**
   * curve mode の mouseUp 処理。
   * 処理した場合は true を返す。
   */
  const handleMouseUpCurve = useCallback((): boolean => {
    // curve handle drag 確定: 最終位置を undoable で書き込む
    if (curveHandleDragRef.current) {
      const { blockId } = curveHandleDragRef.current;
      curveHandleDragRef.current = null;
      // mouseMove 中は undoable=false で書き込んでいるため、mouseUp 時点の
      // 最新 curve を undoable=true で再書き込みして undo スタックに積む。
      const page = getPageData();
      if (page) {
        const block = page.textBlocks.find((b) => b.id === blockId);
        if (block) {
          const newBlocks = page.textBlocks.map((b) =>
            b.id === blockId ? { ...b, isDirty: true } : b,
          );
          updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, true);
        }
      }
      return true;
    }
    return false;
  }, [getPageData, updatePageData, pageIndex]);

  /**
   * curve mode の doubleClick 処理 (#205: polyline 作成開始)。
   * 処理した場合は true を返す。
   */
  const handleDoubleClickCurve = useCallback((pos: { x: number; y: number }): boolean => {
    if (!isCurveMode || selectedIds.size !== 1) return false;
    // polyline draft が既にアクティブな場合はダブルクリックで確定
    if (polylineDraftActive) {
      confirmPolylineDraft();
      return true;
    }
    const pdfPos = canvasToViewport(pos);
    lastDoubleClickTimeRef.current = Date.now();
    // arc 収集をリセットしてから polyline draft 開始
    setCurveClickPoints([]);
    setPolylineDraftPoints([pdfPos]);
    setPolylineDraftActive(true);
    polylineMousePosRef.current = pos;
    return true;
  }, [isCurveMode, selectedIds, polylineDraftActive, confirmPolylineDraft, canvasToViewport]);

  return {
    curveClickPoints,
    curveHandleDragRef,
    polylineDraftPoints,
    polylineDraftActive,
    polylineMousePosRef,
    lastDoubleClickTimeRef,
    handleMouseDownCurve,
    handleMouseMoveCurve,
    handleMouseUpCurve,
    handleDoubleClickCurve,
    hitTestCurveHandle,
    canvasToViewport,
  };
}
