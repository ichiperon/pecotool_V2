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

// ダブルクリック直後のシングルクリックイベントを抑制するガード時間 (ms) (#260)
const DOUBLE_CLICK_GUARD_MS = 300;
// #424 (PCT-193): polyline セグメントがこの長さ (viewport 座標, zoom 非依存)
// 未満の場合はゼロ長相当とみなす。curveGlyphLayout.ts の layoutOnPolyline が
// `len === 0` のセグメントを無視するのと同じ意図で、丸め誤差程度の非ゼロ値
// (ほぼ同一点のクリック) も含めて退化 curve を弾くための閾値。
const MIN_POLYLINE_SEGMENT_LENGTH = 0.01;
import { arcFromThreePoints, arcHandlePositions } from "../utils/arcFromThreePoints";
import { isCurveDefinition } from "../utils/curveDefinition";
import {
  canvasToViewport as canvasToViewportUtil,
  viewportToCanvas as viewportToCanvasUtil,
} from "../utils/coordTransform";
import type { Action, CurveDefinition, PageData, TextBlock } from "../types";

export interface UseCurveEditorParams {
  pageIndex: number;
  zoom: number;
  isCurveMode: boolean;
  selectedIds: Set<string>;
  currentTextBlocksById: Map<string, TextBlock>;
  getPageData: () => PageData | undefined;
  updatePageData: (pageIndex: number, partial: Partial<PageData>, pushUndo?: boolean) => void;
  /**
   * #356 (PCT-133): curve handle drag 確定時に「ドラッグ開始時点 → 確定後」の
   * 1 件の Action を手動で積むために使う (useBlockDragResize と同じ役割)。
   */
  pushAction: (action: Action) => void;
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
    pushAction,
    overlayCanvasRef,
    renderOverlaysRef,
    overlayRafRef,
  } = params;

  // ── Curve mode state (issue #189) ─────────────────────────────
  // 3 点クリックで arc を作成する際に収集する中間点（viewport 座標 / zoom 適用前）
  const [curveClickPoints, setCurveClickPoints] = useState<Array<{ x: number; y: number }>>([]);
  // handle drag: どの handle を掴んでいるか (0=始点 1=中点 2=終点)、null=非ドラッグ
  const curveHandleDragRef = useRef<{ handleIndex: number; blockId: string } | null>(null);
  // #356 (PCT-133): handle drag 開始時点のページ全体のスナップショット。
  // mouseUp で undo Action の before として使う (useBlockDragResize の preDragPageRef と同じ役割)。
  const preDragCurvePageRef = useRef<PageData | null>(null);
  // #431 FB-5: handle drag 中の mousemove を RAF に coalesce するための ref 群。
  // useBlockDragResize (#91/#172) の dragRafRef/pendingDragPosRef と同じパターン。
  const curveDragRafRef = useRef<number | null>(null);
  const pendingCurveDragPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── #205: Polyline 作成 draft state ───────────────────────────
  const [polylineDraftPoints, setPolylineDraftPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [polylineDraftActive, setPolylineDraftActive] = useState(false);
  // マウス現在位置 (canvas 座標) を ref で保持して preview 線に使う（再レンダ不要）
  const polylineMousePosRef = useRef<{ x: number; y: number } | null>(null);
  // ダブルクリック直後のシングルクリックイベントを抑制するためのタイムスタンプ ref
  const lastDoubleClickTimeRef = useRef<number>(0);
  // #265: cursor 更新を RAF スロットルに乗せるための ref
  const cursorRafRef = useRef<number | null>(null);

  /**
   * canvas 座標 (zoom 適用済み) → viewport 座標 (zoom 等倍) に戻す。
   * curveDefinition / arcFromThreePoints は zoom 非適用の viewport 座標で扱う。
   * #409 (PCT-178): 実体は共有 util coordTransform.ts の canvasToViewport に抽出済み。
   * ここでは zoom を閉じ込めた useCallback でラップして従来の呼び出し形を維持する。
   */
  const canvasToViewport = useCallback(
    (pos: { x: number; y: number }) => canvasToViewportUtil(pos, zoom),
    [zoom],
  );

  /**
   * 選択中 BB の arc handle に pos が当たっているか確認し、
   * hit した handle index を返す。hit なし → null。
   */
  const hitTestCurveHandle = useCallback((pos: { x: number; y: number }): { blockId: string; handleIndex: number } | null => {
    if (!isCurveMode) return null;
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
        const { x: hx, y: hy } = viewportToCanvasUtil(handles[hi], zoom);
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

    // #424 (PCT-193): 全点が実質同一点（隣接セグメントが全てゼロ長相当）の
    // polyline は curveGlyphLayout.ts の layoutOnPolyline が空配列を返し、
    // 保存コアでブロックの文字が丸ごと落ちる（文字消失）。退化した curve は
    // ここで拒否し、draft はクリアせず残す（ユーザーが別の点をクリックし直せる）。
    const hasNonDegenerateSegment = polylineDraftPoints.some((p, i) => {
      if (i === 0) return false;
      const prev = polylineDraftPoints[i - 1];
      return Math.hypot(p.x - prev.x, p.y - prev.y) >= MIN_POLYLINE_SEGMENT_LENGTH;
    });
    if (!hasNonDegenerateSegment) return;

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

  // #417 (PCT-186) / PCT-139 #1: curve モード解除・ページ移動・選択変更の
  // いずれでも、入力途中の arc 3点クリック収集 (curveClickPoints) と
  // polyline draft を破棄する。selectedIds はページ移動 (setCurrentPage) の
  // たびに空集合へリセットされるため、依存に含めることでページ移動も検知できる。
  // (#288 の split hover クリアと同パターン)
  useEffect(() => {
    if (!isCurveMode) {
      setCurveClickPoints([]);
      setPolylineDraftPoints([]);
      setPolylineDraftActive(false);
      polylineMousePosRef.current = null;
    }
  }, [isCurveMode]);

  useEffect(() => {
    setCurveClickPoints([]);
    setPolylineDraftPoints([]);
    setPolylineDraftActive(false);
    polylineMousePosRef.current = null;
    // selectedIds の参照は毎回変わるが、値としての変化（ページ移動 / 選択変更）
    // のたびにクリアしたいので依存に含める。中身の内容比較ではなく参照変化で十分
    // （selectedIds は toggleSelection / setCurrentPage 等が呼ばれるたび新しい
    // Set インスタンスを作る前提。既存 hitTestCurveHandle 等も同様の前提）。
  }, [selectedIds]);

  // #431 FB-5: unmount 時に保留中の curve handle drag RAF をクリーンアップ
  // (useBlockDragResize の unmount effect と同じ安全装置)。
  useEffect(() => {
    return () => {
      if (curveDragRafRef.current !== null) {
        cancelAnimationFrame(curveDragRafRef.current);
        curveDragRafRef.current = null;
      }
      pendingCurveDragPosRef.current = null;
    };
  }, []);

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
      if (now - lastDoubleClickTimeRef.current < DOUBLE_CLICK_GUARD_MS) return true;
      const pdfPos = canvasToViewport(pos);
      setPolylineDraftPoints((prev) => [...prev, pdfPos]);
      return true;
    }

    // handle hit-test (既存 curve がある場合)
    const hit = hitTestCurveHandle(pos);
    if (hit) {
      curveHandleDragRef.current = { handleIndex: hit.handleIndex, blockId: hit.blockId };
      // #356 (PCT-133): ドラッグ開始時点のページ全体をスナップショットして
      // mouseUp 側の undo Action の before に使う (useBlockDragResize と同じパターン)。
      const preDragPage = getPageData();
      if (preDragPage) {
        preDragCurvePageRef.current = { ...preDragPage, textBlocks: [...preDragPage.textBlocks] };
      }
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

  // #431 FB-5: curve handle drag の実処理本体。RAF コールバックおよび
  // handleMouseUpCurve の flush (未処理 pending が残っている場合) の両方から
  // 呼ばれる。useBlockDragResize の applyDragResize と同じ役割。
  const applyCurveHandleDrag = useCallback((pos: { x: number; y: number }): void => {
    if (!curveHandleDragRef.current) return;
    const { blockId, handleIndex } = curveHandleDragRef.current;
    const block = currentTextBlocksById.get(blockId);
    if (!block?.curve || !isCurveDefinition(block.curve)) return;
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
  }, [currentTextBlocksById, canvasToViewport, getPageData, updatePageData, pageIndex]);

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

    // #431 FB-5: curve handle drag 中: 同一フレーム内の複数 mousemove を
    // coalesce し、RAF コールバックで 1 度だけ updatePageData を呼ぶ
    // (useBlockDragResize の updateDragResize と同じパターン)。
    if (curveHandleDragRef.current) {
      pendingCurveDragPosRef.current = pos;
      if (curveDragRafRef.current === null) {
        curveDragRafRef.current = requestAnimationFrame(() => {
          curveDragRafRef.current = null;
          const next = pendingCurveDragPosRef.current;
          pendingCurveDragPosRef.current = null;
          if (next) applyCurveHandleDrag(next);
        });
      }
      return true;
    }

    // cursor 更新 (isCurveMode のとき): RAF スロットルで毎 mousemove の hitTest を間引く (#265)
    if (isCurveMode) {
      if (cursorRafRef.current) cancelAnimationFrame(cursorRafRef.current);
      const capturedPos = pos;
      cursorRafRef.current = requestAnimationFrame(() => {
        cursorRafRef.current = null;
        const hit = hitTestCurveHandle(capturedPos);
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.style.cursor = hit ? "pointer" : "crosshair";
        }
      });
      return true;
    }

    return false;
  }, [polylineDraftActive, renderOverlaysRef, overlayRafRef, applyCurveHandleDrag, isCurveMode, hitTestCurveHandle, overlayCanvasRef]);

  /**
   * curve mode の mouseUp 処理。
   * 処理した場合は true を返す。
   */
  const handleMouseUpCurve = useCallback((): boolean => {
    // curve handle drag 確定: 最終位置を undoable で書き込む
    if (curveHandleDragRef.current) {
      // #431 FB-5: ドロップ位置を確実に反映するため、保留中の RAF を
      // キャンセルして pending pos を同期的に flush する
      // (useBlockDragResize の finishDragResize と同じ流儀)。
      if (curveDragRafRef.current !== null) {
        cancelAnimationFrame(curveDragRafRef.current);
        curveDragRafRef.current = null;
      }
      const pendingPos = pendingCurveDragPosRef.current;
      pendingCurveDragPosRef.current = null;
      if (pendingPos) applyCurveHandleDrag(pendingPos);

      const { blockId } = curveHandleDragRef.current;
      curveHandleDragRef.current = null;

      // #356 (PCT-133): mouseMove 中は undoable=false で逐次書き込んでいるため、
      // ここで最新 curve を単純に undoable=true で再書き込みすると、pecoStore が
      // undo エントリの before に取る「直前の oldPage」が既にドラッグ後の状態を
      // 指してしまい、before と after が実質同値になって undo が効かなくなる
      // (#356 の再現条件)。useBlockDragResize の preDragPageRef + 手動 pushAction
      // と同じ方式に揃え、ドラッグ開始時点のスナップショットを before、確定後の
      // ページを after として 1 件だけ Action を積む。
      // #266: find (O(n)) → currentTextBlocksById.get (O(1)) に変更
      const block = currentTextBlocksById.get(blockId);
      const preDragPage = preDragCurvePageRef.current;
      preDragCurvePageRef.current = null;
      if (block && preDragPage) {
        const page = getPageData();
        if (page) {
          const newBlocks = page.textBlocks.map((b) =>
            b.id === blockId ? { ...b, isDirty: true } : b,
          );
          // 確定書き込みは undoable=false: undo Action は下の pushAction で 1 度だけ積む。
          updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, false);

          const after = getPageData();
          const action: Action = {
            type: "update_page",
            pageIndex,
            before: preDragPage,
            after: after ? { ...after } : { ...page, textBlocks: newBlocks, isDirty: true },
          };
          pushAction(action);
        }
      }
      return true;
    }
    return false;
  }, [currentTextBlocksById, getPageData, updatePageData, pageIndex, applyCurveHandleDrag, pushAction]);

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
