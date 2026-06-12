/**
 * PdfCanvas overlay 描画ユーティリティ (issue #218)
 *
 * Public exports:
 *   - `drawStaticBlock`      — axis-aligned または curve 付きブロックを 1 件描画
 *   - `drawStaticBlockCurve` — curve 付きブロック専用の per-glyph 描画 (色セット引数付き)
 *   - `renderStaticLayer`    — TextBlock[] 全体をキャンバスに一括描画
 */
import { isCurveDefinition } from "./curveDefinition";
import { layoutTextOnCurveViewport } from "./curveGlyphLayout";
import { getProblematicBlockIds } from "./blockQuality";
import type { TextBlock } from "../types";

/**
 * curve 付きブロックを描画する際の色セット (実際の rgba 文字列を格納)。
 * 静的層は青系塗り/赤テキスト、動的層は選択ハイライト青系で使い分ける。
 * alpha は呼び出し元で計算済みの rgba(...) 文字列として渡す。
 */
export interface BlockColors {
  /** glyph 背景の塗り色 */
  fillColor: string;
  /** glyph テキストのアウトライン色 */
  strokeColor: string;
  /** glyph テキスト本体の色 */
  textColor: string;
}

/**
 * #341: measureText の結果をキャッシュする上限付き Map（挿入順 evict = FIFO）。
 * キー = "<context.font>|<text>" で font (fontSize 含む) + テキスト変化に対応。
 * 上限 MEASURE_CACHE_MAX を超えたら Map 挿入順の最古エントリを削除する。
 */
const MEASURE_CACHE_MAX = 500;
const measureCache = new Map<string, number>();

/** @internal テスト専用: キャッシュをリセットする */
export function _clearMeasureCacheForTest(): void {
  measureCache.clear();
}

function cachedMeasureText(context: CanvasRenderingContext2D, text: string): number {
  const key = `${context.font}|${text}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) return cached;
  const width = context.measureText(text).width || 1;
  if (measureCache.size >= MEASURE_CACHE_MAX) {
    // Map の挿入順で最古キーを削除
    const firstKey = measureCache.keys().next().value;
    if (firstKey !== undefined) measureCache.delete(firstKey);
  }
  measureCache.set(key, width);
  return width;
}

export function drawStaticBlock(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scale: number,
  opacity: number,
  searchTermLower?: string,
  isActiveHit?: boolean,
  /** @deprecated Pass isProblematic instead. Kept for call-site compatibility — value is ignored. */
  _confidenceThreshold?: number,
  showLowConfidenceHighlight?: boolean,
  /** PCT-048: pre-computed flag from getProblematicBlockIds(); replaces confidence heuristic */
  isProblematic?: boolean,
): void {
  // curve 付き block は per-glyph の curve 描画パスへ
  if (block.curve && isCurveDefinition(block.curve)) {
    drawStaticBlockCurve(context, block, scale, opacity, searchTermLower, isActiveHit, undefined, showLowConfidenceHighlight, undefined, isProblematic);
    return;
  }

  // ── 既存 axis-aligned パス ──────────────────────────────────────────
  const x = block.bbox.x * scale;
  const y = block.bbox.y * scale;
  const w = block.bbox.width * scale;
  const h = block.bbox.height * scale;
  const inset = 1;
  const baseAlpha = opacity;
  // PCT-048: alpha raised from 0.25 → 0.4 for problematic blocks so the
  // highlight is clearly visible while normal blocks keep the subtle 0.25.
  const normalFillAlpha = opacity * 0.25;
  const problematicFillAlpha = opacity * 0.4;

  // PCT-048: problematic flag (empty block or significant BB overlap)
  const flagged = showLowConfidenceHighlight === true && isProblematic === true;

  context.fillStyle = flagged
    ? `rgba(220, 38, 38, ${problematicFillAlpha})`
    : `rgba(0, 150, 255, ${normalFillAlpha})`;
  context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  // PCT-048: problematic blocks get a stronger red border (lineWidth 2),
  // normal blocks keep the existing thin red outline (lineWidth 1).
  context.strokeStyle = flagged
    ? `rgba(220, 38, 38, ${baseAlpha})`
    : `rgba(255, 0, 0, ${baseAlpha * 0.6})`;
  context.lineWidth = flagged ? 2 : 1;
  context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  // issue #196: 検索ヒットの黄色ハイライト
  if (searchTermLower && block.text.toLowerCase().includes(searchTermLower)) {
    context.fillStyle = isActiveHit
      ? 'rgba(255, 180, 0, 0.7)'
      : 'rgba(255, 230, 0, 0.4)';
    context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
    if (isActiveHit) {
      context.strokeStyle = 'rgba(255, 140, 0, 1)';
      context.lineWidth = 2;
      context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
    }
  }

  if (!block.text) return;
  if (block.writingMode === "vertical") {
    const fontSize = Math.max(10, w * 0.8);
    context.save();
    context.font = `bold ${fontSize}px sans-serif`;
    context.textBaseline = "top";

    const naturalHeight = block.text.length * fontSize;
    const sy = h / naturalHeight;

    context.translate(x + w, y + 2);
    context.scale(1, sy);
    context.rotate(Math.PI / 2);
    context.lineWidth = 3 / sy;
    context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
    context.strokeText(block.text, 0, 0);
    context.fillStyle = `rgba(255, 0, 0, ${baseAlpha})`;
    context.fillText(block.text, 0, 0);
    context.restore();
    return;
  }

  const fontSize = Math.max(10, h * 0.8);
  context.save();
  context.font = `bold ${fontSize}px sans-serif`;
  context.textBaseline = "top";

  const textWidth = cachedMeasureText(context, block.text); // #341: LRU memo
  const sx = w / textWidth;

  context.translate(x, y + 2);
  context.scale(sx, 1);
  context.lineWidth = 3 / sx;
  context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
  context.strokeText(block.text, 0, 0);
  context.fillStyle = `rgba(255, 0, 0, ${baseAlpha})`;
  context.fillText(block.text, 0, 0);
  context.restore();
}

/**
 * curve 付き TextBlock の overlay 描画 (issue #188 / Phase 4, #290)。
 * 各文字を viewport 座標系上のカーブに沿って配置し、
 * 文字幅×文字高の矩形をカラーセットで描く (inset=1)。
 *
 * @param colors - 省略時は静的層デフォルト色 (青塗り/赤テキスト) を使用。
 *                 動的層 (選択ハイライト) は呼び出し元で構築した色を渡す。
 */
export function drawStaticBlockCurve(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scale: number,
  opacity: number,
  searchTermLower?: string,
  isActiveHit?: boolean,
  /** @deprecated Ignored. Kept for call-site compatibility. */
  _confidenceThreshold?: number,
  showLowConfidenceHighlight?: boolean,
  colors?: BlockColors,
  /** PCT-048: pre-computed flag from getProblematicBlockIds() */
  isProblematic?: boolean,
): void {
  const h = block.bbox.height * scale;
  const fontSize = Math.max(10, h * 0.8);
  const inset = 1;
  const baseAlpha = opacity;
  const normalFillAlpha = opacity * 0.25;
  const problematicFillAlpha = opacity * 0.4;

  let fillColor: string;
  let glyphStrokeColor: string;
  let glyphTextColor: string;

  if (colors) {
    // 呼び出し元から明示的な色セットが渡された場合 (動的層など)
    fillColor = colors.fillColor;
    glyphStrokeColor = colors.strokeColor;
    glyphTextColor = colors.textColor;
  } else {
    // PCT-048: problematic flag (empty or overlapping block)
    const flagged = showLowConfidenceHighlight === true && isProblematic === true;
    fillColor = flagged
      ? `rgba(220, 38, 38, ${problematicFillAlpha})`
      : `rgba(0, 150, 255, ${normalFillAlpha})`;
    glyphStrokeColor = `rgba(255, 255, 255, ${baseAlpha})`;
    glyphTextColor = `rgba(255, 0, 0, ${baseAlpha})`;
  }

  context.font = `bold ${fontSize}px sans-serif`;
  context.textBaseline = "top";

  // curve! が valid である前提 (呼び出し元で guard 済み)
  const glyphs = layoutTextOnCurveViewport(block.text, block.curve!, fontSize);

  // #240: save/restore をループ外で 1 回に削減。
  // ループ内では setTransform で translate+rotate を直接設定し、
  // glyph ごとの save/restore オーバーヘッドを排除する。
  context.save();
  // ループ外で変わらない描画状態を先に設定
  context.lineWidth = 3;

  for (const g of glyphs) {
    const gx = g.x * scale;
    const gy = g.y * scale;
    // 簡易文字幅は fontSize 相当の正方形 (等幅概算)
    const gw = fontSize;
    const gh = fontSize;

    const cos = Math.cos(g.rotation);
    const sin = Math.sin(g.rotation);
    // setTransform(a, b, c, d, e, f) = 2D affine: translate(gx,gy) * rotate(rotation)
    context.setTransform(cos, sin, -sin, cos, gx, gy);

    context.fillStyle = fillColor;
    context.fillRect(-gw / 2 + inset, -inset, gw - inset * 2, gh - inset * 2);

    if (block.text) {
      context.strokeStyle = glyphStrokeColor;
      context.strokeText(g.char, -gw / 2, -gh * 0.1);
      context.fillStyle = glyphTextColor;
      context.fillText(g.char, -gw / 2, -gh * 0.1);
    }
  }

  // transform を恒等行列に戻してから restore (後続の描画を保護)
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.restore();

  // issue #196: curve block の検索ヒット黄色ハイライトは bbox 全体に重ねる
  if (searchTermLower && block.text.toLowerCase().includes(searchTermLower)) {
    const bx = block.bbox.x * scale;
    const by = block.bbox.y * scale;
    const bw = block.bbox.width * scale;
    const bh = block.bbox.height * scale;
    context.save();
    context.fillStyle = isActiveHit
      ? 'rgba(255, 180, 0, 0.7)'
      : 'rgba(255, 230, 0, 0.4)';
    context.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
    if (isActiveHit) {
      context.strokeStyle = 'rgba(255, 140, 0, 1)';
      context.lineWidth = 2;
      context.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    }
    context.restore();
  }
}

export function renderStaticLayer(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  textBlocks: TextBlock[] | null | undefined,
  selectedIds: Set<string>,
  showOcr: boolean,
  zoom: number,
  opacity: number,
  searchTerm?: string,
  searchHitIndex?: number,
  /** @deprecated Ignored (PCT-048). Kept for call-site compatibility. */
  _confidenceThreshold?: number,
  showLowConfidenceHighlight?: boolean,
): void {
  // 注: 以前は block 単位の offscreen canvas キャッシュ + drawImage 経由で描画していたが、
  // drawImage の非整数 dst 座標でサブピクセル補間が発生し、OCR overlay が
  // 実テキストより上方向に 2-4px ズレて見える視覚的回帰を起こしたため、
  // v2.0.4 以前の直接描画に戻している。
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showOcr || !textBlocks) return;

  const scale = zoom / 100;
  // issue #196: searchTerm が空でない場合、ヒットするブロックを収集して activeHit を決定する
  const term = searchTerm && searchTerm.length > 0 ? searchTerm : undefined;
  // #220: toLowerCase を N 回呼ばずループ外で 1 度だけ計算してキャッシュ
  const termLower = term ? term.toLowerCase() : undefined;
  let hitCounter = -1;
  const activeIndex = searchHitIndex ?? 0;

  // PCT-048: Compute problematic block IDs once for the whole page so each
  // drawStaticBlock call can check membership in O(1).
  const problematicIds = showLowConfidenceHighlight
    ? getProblematicBlockIds(textBlocks)
    : new Set<string>();

  for (const block of textBlocks) {
    if (selectedIds.has(block.id)) continue;
    let isActiveHit = false;
    if (termLower && block.text.toLowerCase().includes(termLower)) {
      hitCounter++;
      isActiveHit = hitCounter === activeIndex;
    }
    const isProblematic = problematicIds.has(block.id);
    drawStaticBlock(context, block, scale, opacity, termLower, isActiveHit, undefined, showLowConfidenceHighlight, isProblematic);
  }
}
