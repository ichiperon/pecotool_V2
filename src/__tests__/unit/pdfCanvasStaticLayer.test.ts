/**
 * OCR overlay 静的層 guardrail テスト (issue: v2.0.5/2.0.6 視覚ズレ回帰)
 *
 * v2.0.5/2.0.6 では `drawStaticBlock` を offscreen canvas + drawImage 経由の
 * キャッシュに置き換えたが、drawImage の非整数 dst 座標でサブピクセル補間が
 * 発生し OCR overlay が上方向に 2-4px ズレる視覚回帰を起こした (fd65488)。
 * v2.0.7 で v2.0.4 相当の直接描画に戻している。
 *
 * 本テストは「キャッシュ機構が再導入されたら CI で確実に落ちる」guardrail。
 *   - context.drawImage が renderStaticLayer 実行中に 1 度も呼ばれない
 *   - fillRect / strokeRect が inset=1 / scale 適用済みの座標で呼ばれる
 *   - 選択ブロックは描画スキップ
 *   - showOcr=false なら clearRect 以外は呼ばれない
 *   - text 非空ならテキスト描画パス (rotate / fillText) が走る
 *
 * Phase 4 (#188): curve 付き block の描画テストを追加。
 *   - fillRect が文字数分呼ばれる (axis-aligned は 1 回、curve は字数分)
 *   - drawImage は呼ばれない (Phase 2 cache 再導入 guard 維持)
 *   - save / restore / translate / rotate が呼ばれる (字ごとの回転)
 */
import { describe, it, expect, vi } from 'vitest'

// PdfCanvas は import 連鎖で pdfjs-dist を読み込み jsdom 上で DOMMatrix エラーを
// 起こすため、helper だけを取り出すのに必要な subset を mock する。
vi.mock('pdfjs-dist', () => ({ default: {} }))
vi.mock('../../utils/pdfLoader', () => ({ getCachedPageProxy: vi.fn() }))

import { drawStaticBlock, drawStaticBlockCurve, renderStaticLayer } from '../../utils/pdfCanvasRender'
import { layoutTextOnCurveViewport } from '../../utils/curveGlyphLayout'
import type { TextBlock, CurveDefinition } from '../../types'

function makeMockContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 50 }),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    // PCT-169: drawStaticBlockCurve は現在の変換行列を getTransform で取得し
    // base として復帰に使う。既定は恒等行列 (rotation なし相当)。
    getTransform: vi.fn(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })),
    transform: vi.fn(),
    setTransform: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: '',
    lineWidth: 0,
  }
}

function makeMockCanvas(width = 500, height = 500): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'b0',
    text: 'A',
    originalText: '',
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  }
}

describe('PdfCanvas static layer guardrail (cache regression detector)', () => {
  it('never calls drawImage during renderStaticLayer (cache reintroduction detector)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const blocks = Array.from({ length: 5 }, (_, i) =>
      makeBlock({ id: `b${i}`, bbox: { x: i * 20, y: 10, width: 18, height: 18 } }),
    )

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      blocks,
      new Set(),
      true,
      100,
      0.5,
    )

    // 重要: drawImage が呼ばれていたら offscreen canvas キャッシュが
    // 再導入された証拠であり、視覚ズレ回帰が再発した可能性が高い。
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  it('applies inset=1 and scale=zoom/100 to fillRect/strokeRect coords (zoom=150)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({
      text: '',
      bbox: { x: 10, y: 20, width: 100, height: 30 },
    })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      150,
      0.5,
    )

    // scale = 150/100 = 1.5, inset = 1
    //   fillRect(x*1.5 + 1, y*1.5 + 1, w*1.5 - 2, h*1.5 - 2)
    //          = (10*1.5+1, 20*1.5+1, 100*1.5-2, 30*1.5-2)
    //          = (16, 31, 148, 43)
    expect(ctx.fillRect).toHaveBeenCalledWith(16, 31, 148, 43)
    expect(ctx.strokeRect).toHaveBeenCalledWith(16, 31, 148, 43)
  })

  it('skips blocks present in selectedIds (no fillRect / strokeRect for them)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const blocks = [
      makeBlock({ id: 'b0', text: '' }),
      makeBlock({ id: 'b1', text: '', bbox: { x: 200, y: 200, width: 50, height: 20 } }),
    ]

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      blocks,
      new Set(['b0', 'b1']),
      true,
      100,
      0.5,
    )

    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.strokeRect).not.toHaveBeenCalled()
  })

  it('with showOcr=false only clearRect runs (no fill/stroke/text/drawImage at all)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas(640, 480)
    const blocks = [makeBlock()]

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      blocks,
      new Set(),
      false,
      100,
      0.5,
    )

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 640, 480)
    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.strokeRect).not.toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
    expect(ctx.strokeText).not.toHaveBeenCalled()
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  it('horizontal text block triggers fillText (no rotate)', () => {
    const ctx = makeMockContext()
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeBlock({ text: 'hello', writingMode: 'horizontal' }),
      1,
      0.5,
    )
    expect(ctx.fillText).toHaveBeenCalled()
    expect(ctx.rotate).not.toHaveBeenCalled()
  })

  it('vertical writing mode goes through rotate path', () => {
    const ctx = makeMockContext()
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeBlock({ text: 'あ', writingMode: 'vertical' }),
      1,
      0.5,
    )
    expect(ctx.rotate).toHaveBeenCalled()
    expect(ctx.fillText).toHaveBeenCalled()
  })
})

describe('PdfCanvas static layer – curve block (Phase 4 #188)', () => {
  function makeCurveBlock(text: string, curve: CurveDefinition): TextBlock {
    return {
      id: 'c0',
      text,
      originalText: '',
      bbox: { x: 50, y: 50, width: 200, height: 40 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: false,
      curve,
    }
  }

  const arcCurve: CurveDefinition = {
    type: 'arc',
    center: { x: 150, y: 150 },
    radius: 80,
    startAngle: Math.PI,
    endAngle: 2 * Math.PI,
  }

  it('curve (arc) 付き block: fillRect が文字数分呼ばれる (字ごと描画)', () => {
    const ctx = makeMockContext()
    const text = 'ABCDE'
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text, arcCurve),
      1,
      0.5,
    )
    // curve パスでは 1 文字ごとに fillRect が 1 回呼ばれる
    expect(ctx.fillRect).toHaveBeenCalledTimes(text.length)
  })

  it('curve 描画でも drawImage は呼ばれない (cache 再導入 guard 維持)', () => {
    const ctx = makeMockContext()
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock('ABC', arcCurve),
      1,
      0.5,
    )
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  it('curve 描画で save / restore はループ外で 1 回、setTransform が字数分呼ばれる (#240)', () => {
    const ctx = makeMockContext()
    const text = 'XYZ'
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text, arcCurve),
      1,
      0.5,
    )
    // #240: save/restore はループ外で 1 回だけ (per-glyph save/restore は廃止)
    expect(ctx.save).toHaveBeenCalledTimes(1)
    expect(ctx.restore).toHaveBeenCalledTimes(1)
    // PCT-169: ループ内では setTransform(base) で復帰 → transform で glyph 変換を乗算合成
    expect(ctx.setTransform).toHaveBeenCalledTimes(text.length + 1) // +1 はループ後の base 復帰
    expect(ctx.transform).toHaveBeenCalledTimes(text.length)
  })

  it('axis-aligned (curve なし) block は依然として fillRect が 1 回', () => {
    const ctx = makeMockContext()
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeBlock({ text: '' }), // curve なし
      1,
      0.5,
    )
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)
  })

  it('curve (polyline) 付き block: fillRect が文字数分呼ばれる', () => {
    const ctx = makeMockContext()
    const polylineCurve: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 50, y: 100 },
        { x: 150, y: 80 },
        { x: 250, y: 100 },
      ],
    }
    const text = 'WX'
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text, polylineCurve),
      1,
      0.5,
    )
    expect(ctx.fillRect).toHaveBeenCalledTimes(text.length)
  })
})

// ── PCT-048: 要確認ハイライト (赤系 fillRect) ─────────────────────────────
// Replaces the old confidence-based test group (#192).
// drawStaticBlock now receives an explicit `isProblematic` flag (9th arg)
// instead of deriving it from confidence + threshold.
describe('PdfCanvas static layer – problematic block highlight (PCT-048)', () => {
  it('isProblematic=true + showLowConfidenceHighlight=true → 赤系 fillStyle が設定される', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '' })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined, // searchTermLower
      undefined, // isActiveHit
      undefined, // _confidenceThreshold (deprecated, ignored)
      true,      // showLowConfidenceHighlight
      true,      // isProblematic
    )

    // fillStyle が赤系 rgba(220, 38, 38, ...) で設定されたことを確認
    expect(ctx.fillStyle).toMatch(/rgba\(220,\s*38,\s*38/)
  })

  it('isProblematic=false → 青系 fillStyle が fillRect 時に設定される', () => {
    const capturedFillStyles: string[] = []
    const ctx = {
      ...makeMockContext(),
      fillStyle: '',
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        capturedFillStyles.push(this.fillStyle)
      }),
    }
    const block = makeBlock({ text: 'normal' })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      undefined,
      true,
      false, // isProblematic=false
    )

    // First fillRect call is the block background fill
    expect(capturedFillStyles[0]).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('showLowConfidenceHighlight=false のとき isProblematic=true でも青系 fillStyle になる', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '' })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      undefined,
      false,  // showLowConfidenceHighlight=false
      true,   // isProblematic=true (ignored because toggle is OFF)
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('isProblematic=undefined → 青系 fillStyle になる (フラグ未指定)', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '' })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      undefined,
      true,
      // isProblematic omitted
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('renderStaticLayer 経由: 空ブロックは赤系ハイライトになる (showLowConfidenceHighlight=true)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    // Empty text → isEmptyBlock() = true → getProblematicBlockIds flags it
    const block = makeBlock({ text: '' })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      undefined,
      undefined,
      undefined, // _confidenceThreshold (deprecated)
      true,      // showLowConfidenceHighlight
    )

    expect(ctx.fillStyle).toMatch(/rgba\(220,\s*38,\s*38/)
  })

  it('renderStaticLayer 経由: 非空ブロックは青系ハイライトになる (fillRect 時)', () => {
    const capturedFillStyles: string[] = []
    const ctx = {
      ...makeMockContext(),
      fillStyle: '',
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        capturedFillStyles.push(this.fillStyle)
      }),
    }
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'hello' })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      undefined,
      undefined,
      undefined,
      true,
    )

    // First fillRect call is the block background fill
    expect(capturedFillStyles[0]).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('renderStaticLayer 経由: showLowConfidenceHighlight=false → 空ブロックでも青系', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: '' })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      undefined,
      undefined,
      undefined,
      false, // showLowConfidenceHighlight=false
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('renderStaticLayer 経由: 完全重複ブロックの両方が赤系ハイライトになる', () => {
    // PCT-048: BB overlap detection via getProblematicBlockIds
    // Two identical bboxes → intersection/min = 1.0 >= BB_OVERLAP_RATIO
    const capturedFillStyles: string[] = []
    const ctx = {
      ...makeMockContext(),
      fillStyle: '',
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        capturedFillStyles.push(this.fillStyle)
      }),
    }
    const canvas = makeMockCanvas()
    const blocks = [
      makeBlock({ id: 'b1', text: 'A', bbox: { x: 0, y: 0, width: 100, height: 100 } }),
      makeBlock({ id: 'b2', text: 'B', bbox: { x: 0, y: 0, width: 100, height: 100 } }),
    ]

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      blocks,
      new Set(),
      true,
      100,
      1.0,
      undefined,
      undefined,
      undefined,
      true,
    )

    // Both blocks should use the red fill
    expect(capturedFillStyles.every(s => /rgba\(220,\s*38,\s*38/.test(s))).toBe(true)
  })
})

// ── issue #196: 検索ヒットの黄色ハイライト ──────────────────────────
describe('PdfCanvas static layer – search highlight (issue #196)', () => {
  it('searchTerm が空のとき黄色 fillRect は追加で呼ばれない (axis-aligned)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'hello world', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      '', // searchTerm 空
    )

    // 通常の青 fillRect のみ (1回)
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)
  })

  it('searchTerm がヒットすると黄色 fillRect が追加で呼ばれる (axis-aligned)', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'hello world', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      'hello', // searchTerm ヒット
      0,       // searchHitIndex=0 → activeHit
    )

    // 青 fillRect(1回) + 黄色 fillRect(1回) = 合計 2回
    expect(ctx.fillRect).toHaveBeenCalledTimes(2)
  })

  it('searchTerm がヒットして activeHit のとき黄色 strokeRect が呼ばれる', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'hello', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      'hello',
      0, // activeHit
    )

    // 赤 strokeRect(1回) + オレンジ strokeRect(1回 active) = 合計 2回
    expect(ctx.strokeRect).toHaveBeenCalledTimes(2)
  })

  it('searchTerm がヒットしても activeHit でなければ strokeRect は追加されない', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'hello', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    // searchHitIndex=1 だが block は 0番目のヒットなので activeHit にならない
    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      'hello',
      1, // activeHit ではない
    )

    // 赤 strokeRect のみ (1回)
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1)
  })

  it('searchTerm にヒットしないブロックには黄色 fillRect が呼ばれない', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'goodbye', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      'hello', // ヒットしない
    )

    // 青 fillRect(1回) のみ
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)
  })

  it('大文字小文字を区別せずにヒットする', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: 'Hello World', bbox: { x: 10, y: 20, width: 100, height: 30 } })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      'hello', // 小文字でもヒット
      0,
    )

    // 黄色 fillRect が呼ばれている (青+黄色=2回)
    expect(ctx.fillRect).toHaveBeenCalledTimes(2)
  })
})

// ── PCT-048: showLowConfidenceHighlight トグルが描画に正しく反映される ──
// Replaces the old threshold passthrough regression test (#244).
describe('PdfCanvas static layer – showLowConfidenceHighlight toggle (PCT-048)', () => {
  it('showLowConfidenceHighlight=true → 空ブロックは赤系になる', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    // Empty block is always flagged regardless of confidence value
    const block = makeBlock({ text: '' })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      undefined,
      undefined,
      undefined,
      true, // showLowConfidenceHighlight=true
    )
    expect(ctx.fillStyle).toMatch(/rgba\(220,\s*38,\s*38/)
  })

  it('showLowConfidenceHighlight=false に切り替えると空ブロックでも青系になる', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: '' })

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(),
      true,
      100,
      0.5,
      undefined,
      undefined,
      undefined,
      false, // showLowConfidenceHighlight=false
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })
})

// ── issue #290: 動的層で curve 付き block が drawStaticBlockCurve を通ること ──
describe('PdfCanvas overlay – curve block in dynamic layer (#290)', () => {
  const arcCurve: CurveDefinition = {
    type: 'arc',
    center: { x: 150, y: 150 },
    radius: 80,
    startAngle: Math.PI,
    endAngle: 2 * Math.PI,
  }

  function makeCurveBlock(text: string): TextBlock {
    return {
      id: 'c0',
      text,
      originalText: '',
      bbox: { x: 50, y: 50, width: 200, height: 40 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: false,
      curve: arcCurve,
    }
  }

  it('curve 付き block を drawStaticBlockCurve に colors 引数付きで呼ぶと per-glyph fillRect が走る', () => {
    const ctx = makeMockContext()
    const text = 'ABC'
    const colors = {
      fillColor: 'rgba(0, 100, 255, 0.3)',
      strokeColor: 'rgba(255, 255, 255, 1)',
      textColor: 'rgba(0, 50, 255, 1)',
    }

    drawStaticBlockCurve(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text),
      1,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      colors,
    )

    // per-glyph fillRect が文字数分 (setTransform で各文字の変換後に描画)
    expect(ctx.fillRect).toHaveBeenCalledTimes(text.length)
    // drawImage は一切呼ばれない
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  it('colors 引数で渡した fillColor が glyph 背景色 (fillRect 直前) として使われる', () => {
    const fillColor = 'rgba(0, 100, 255, 0.25)'
    const capturedFillStyles: string[] = []

    // fillRect 呼び出し時点の fillStyle をキャプチャ
    const ctx = {
      ...makeMockContext(),
      fillStyle: '',
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        capturedFillStyles.push(this.fillStyle)
      }),
    }

    drawStaticBlockCurve(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock('X'),
      1,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      { fillColor, strokeColor: 'rgba(255,255,255,1)', textColor: 'rgba(0,50,255,1)' },
    )

    // fillRect 直前に fillColor が設定されている
    expect(capturedFillStyles[0]).toBe(fillColor)
  })

  it('Ctrl+A 全選択相当: curve block が selectedIds に入ると静的層でスキップされ renderStaticLayer は fillRect を呼ばない', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeCurveBlock('HI')

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [block],
      new Set(['c0']), // selectedIds に含める (動的層に移行)
      true,
      100,
      0.5,
    )

    // 静的層では selectedIds に含まれるブロックはスキップ
    expect(ctx.fillRect).not.toHaveBeenCalled()
  })
})

// ── PCT-169 (#400): UI 回転中の curve overlay が回転を保持すること ──────────
// バグ: drawStaticBlockCurve の glyph ループが setTransform(cos, sin, -sin, cos, gx, gy)
// の絶対指定で、呼び出し元が applyRotationTransform で事前適用した UI rotation を
// 上書き消去 → 回転中 curve overlay だけ非回転位置に描画されていた。
// 修正: getTransform() で base を取得し、glyph ごとに setTransform(base) で復帰 →
// transform(...) で乗算合成する。本 describe は「絶対 setTransform の復活」を CI で縛る。
describe('PdfCanvas static layer – curve block keeps pre-applied rotation (PCT-169 / #400)', () => {
  const arcCurve: CurveDefinition = {
    type: 'arc',
    center: { x: 150, y: 150 },
    radius: 80,
    startAngle: Math.PI,
    endAngle: 2 * Math.PI,
  }

  function makeCurveBlock(text: string): TextBlock {
    return {
      id: 'c0',
      text,
      originalText: '',
      bbox: { x: 50, y: 50, width: 200, height: 40 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: false,
      curve: arcCurve,
    }
  }

  // drawStaticBlockCurve 内の fontSize 計算と同一 (scale=1, bbox.height=40)
  const SCALE = 1
  const FONT_SIZE = Math.max(10, 40 * SCALE * 0.8) // = 32

  /** 実装と同じ layout から期待される glyph 変換行列 (a,b,c,d,e,f) を計算する */
  function expectedGlyphMatrices(text: string) {
    return layoutTextOnCurveViewport(text, arcCurve, FONT_SIZE).map((g) => {
      const cos = Math.cos(g.rotation)
      const sin = Math.sin(g.rotation)
      return [cos, sin, -sin, cos, g.x * SCALE, g.y * SCALE]
    })
  }

  it('R=90: 事前適用済み回転行列を base として保持する (setTransform は base 復帰のみ・glyph は transform で乗算合成)', () => {
    // applyRotationTransform(ctx, {rotation: 90, vw: 500}) 適用後の行列に相当
    const rotationBase = { a: 0, b: 1, c: -1, d: 0, e: 500, f: 0 }
    const ctx = {
      ...makeMockContext(),
      getTransform: vi.fn(() => rotationBase),
    }
    const text = 'AB'

    drawStaticBlockCurve(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text),
      SCALE,
      0.5,
    )

    // setTransform は「base への復帰」のみに使われる (字数分 + ループ後 1 回)。
    // 旧バグの絶対指定 setTransform(cos, sin, -sin, cos, gx, gy) が復活すると
    // 6 引数呼び出しが混ざってここで fail する。
    expect(ctx.setTransform).toHaveBeenCalledTimes(text.length + 1)
    for (const call of ctx.setTransform.mock.calls) {
      expect(call).toEqual([rotationBase])
    }

    // glyph の translate+rotate は transform (乗算合成) で適用される
    expect(ctx.transform.mock.calls).toEqual(expectedGlyphMatrices(text))
  })

  it('R=0 (非退行): base=恒等行列でも glyph 変換行列は従来の絶対指定と同値になる', () => {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    const ctx = {
      ...makeMockContext(),
      getTransform: vi.fn(() => identity),
    }
    const text = 'XYZ'

    drawStaticBlockCurve(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text),
      SCALE,
      0.5,
    )

    // base=恒等のとき setTransform(identity) + transform(M) の合成結果は
    // 旧実装の setTransform(M) と同一 (identity × M = M) — 従来動作の非退行を縛る。
    expect(ctx.setTransform).toHaveBeenCalledTimes(text.length + 1)
    for (const call of ctx.setTransform.mock.calls) {
      expect(call).toEqual([identity])
    }
    expect(ctx.transform.mock.calls).toEqual(expectedGlyphMatrices(text))
    // 描画自体も従来どおり字数分走る
    expect(ctx.fillRect).toHaveBeenCalledTimes(text.length)
  })

  it('renderStaticLayer 経由 (rotationParams R=90): applyRotationTransform 適用後に glyph が乗算合成される', () => {
    // renderOverlays / renderStaticLayer 相当の配線を検証する。
    // mock は変換状態を持たないため、getTransform は「回転適用後」の行列を返す設定にする。
    const rotationBase = { a: 0, b: 1, c: -1, d: 0, e: 500, f: 0 }
    const ctx = {
      ...makeMockContext(),
      getTransform: vi.fn(() => rotationBase),
    }
    const canvas = makeMockCanvas(500, 500)
    const text = 'AB'

    renderStaticLayer(
      ctx as unknown as CanvasRenderingContext2D,
      canvas,
      [makeCurveBlock(text)],
      new Set(),
      true,
      100, // zoom=100 → scale=1
      0.5,
      undefined,
      undefined,
      undefined,
      undefined,
      { rotation: 90, vw: 500, vh: 500 },
    )

    // 1回目の transform は applyRotationTransform(R=90) の行列
    expect(ctx.transform.mock.calls[0]).toEqual([0, 1, -1, 0, 500, 0])
    // 以降の transform は glyph の乗算合成 (字数分)
    expect(ctx.transform.mock.calls.slice(1)).toEqual(expectedGlyphMatrices(text))

    // setTransform のうち 6 引数呼び出しは clearRect 用の恒等リセットのみ。
    // 絶対指定の glyph setTransform (回転消去) が復活したらここで fail する。
    const sixArgCalls = ctx.setTransform.mock.calls.filter((c) => c.length === 6)
    expect(sixArgCalls).toEqual([[1, 0, 0, 1, 0, 0]])
    // 残りの setTransform はすべて base 復帰 (字数分 + ループ後 1 回)
    const matrixCalls = ctx.setTransform.mock.calls.filter((c) => c.length === 1)
    expect(matrixCalls).toEqual(Array.from({ length: text.length + 1 }, () => [rotationBase]))
  })
})
