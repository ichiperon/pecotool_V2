/**
 * PdfCanvas overlay 描画ユーティリティ (issue #218)
 *
 * drawStaticBlock / drawStaticBlockCurve / renderStaticLayer を
 * PdfCanvas.tsx から分離して再利用可能な形で export する。
 */
import { isCurveDefinition } from "./curveDefinition";
import { layoutTextOnCurveViewport } from "./curveGlyphLayout";
import type { TextBlock } from "../types";

export function drawStaticBlock(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scale: number,
  opacity: number,
  searchTerm?: string,
  isActiveHit?: boolean,
  confidenceThreshold?: number,
  showLowConfidenceHighlight?: boolean,
): void {
  // curve 付き block は per-glyph の curve 描画パスへ
  if (block.curve && isCurveDefinition(block.curve)) {
    drawStaticBlockCurve(context, block, scale, opacity, searchTerm, isActiveHit, confidenceThreshold, showLowConfidenceHighlight);
    return;
  }

  // ── 既存 axis-aligned パス (変更禁止) ──────────────────────────────────
  const x = block.bbox.x * scale;
  const y = block.bbox.y * scale;
  const w = block.bbox.width * scale;
  const h = block.bbox.height * scale;
  const inset = 1;
  const baseAlpha = opacity;
  const fillAlpha = opacity * 0.25;

  // #192: 低信頼ブロックは赤系塗り、通常は青系
  const isLowConfidence =
    showLowConfidenceHighlight === true &&
    block.confidence !== undefined &&
    confidenceThreshold !== undefined &&
    block.confidence <= confidenceThreshold;

  context.fillStyle = isLowConfidence
    ? `rgba(220, 38, 38, ${fillAlpha})`
    : `rgba(0, 150, 255, ${fillAlpha})`;
  context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  context.strokeStyle = `rgba(255, 0, 0, ${baseAlpha})`;
  context.lineWidth = 1;
  context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  // issue #196: 検索ヒットの黄色ハイライト
  if (searchTerm && block.text.toLowerCase().includes(searchTerm.toLowerCase())) {
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

  const textWidth = context.measureText(block.text).width || 1;
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
 * curve 付き TextBlock の static overlay 描画 (issue #188 / Phase 4)。
 * 各文字を viewport 座標系上のカーブに沿って配置し、
 * 文字幅×文字高の矩形を青塗り + 赤テキストで描く (inset=1)。
 */
function drawStaticBlockCurve(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scale: number,
  opacity: number,
  searchTerm?: string,
  isActiveHit?: boolean,
  confidenceThreshold?: number,
  showLowConfidenceHighlight?: boolean,
): void {
  const h = block.bbox.height * scale;
  const fontSize = Math.max(10, h * 0.8);
  const inset = 1;
  const baseAlpha = opacity;
  const fillAlpha = opacity * 0.25;

  // #192: 低信頼ブロックは赤系塗り、通常は青系
  const isLowConfidence =
    showLowConfidenceHighlight === true &&
    block.confidence !== undefined &&
    confidenceThreshold !== undefined &&
    block.confidence <= confidenceThreshold;
  const fillColor = isLowConfidence
    ? `rgba(220, 38, 38, ${fillAlpha})`
    : `rgba(0, 150, 255, ${fillAlpha})`;

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

    // 文字背景: 低信頼は赤系、通常は青系
    context.fillStyle = fillColor;
    context.fillRect(-gw / 2 + inset, -inset, gw - inset * 2, gh - inset * 2);

    // 文字本体: 赤テキスト
    if (block.text) {
      context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
      context.strokeText(g.char, -gw / 2, -gh * 0.1);
      context.fillStyle = `rgba(255, 0, 0, ${baseAlpha})`;
      context.fillText(g.char, -gw / 2, -gh * 0.1);
    }
  }

  // transform を恒等行列に戻してから restore (後続の描画を保護)
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.restore();

  // issue #196: curve block の検索ヒット黄色ハイライトは bbox 全体に重ねる
  if (searchTerm && block.text.toLowerCase().includes(searchTerm.toLowerCase())) {
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
  confidenceThreshold?: number,
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

  for (const block of textBlocks) {
    if (selectedIds.has(block.id)) continue;
    let isActiveHit = false;
    if (termLower && block.text.toLowerCase().includes(termLower)) {
      hitCounter++;
      isActiveHit = hitCounter === activeIndex;
    }
    drawStaticBlock(context, block, scale, opacity, term, isActiveHit, confidenceThreshold, showLowConfidenceHighlight);
  }
}
