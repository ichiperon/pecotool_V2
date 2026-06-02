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

import { drawStaticBlock, renderStaticLayer } from '../../components/PdfCanvas'
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

  it('curve 描画で save / restore / translate / rotate が呼ばれる (字ごと回転)', () => {
    const ctx = makeMockContext()
    const text = 'XYZ'
    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      makeCurveBlock(text, arcCurve),
      1,
      0.5,
    )
    // 3 文字 → save/restore/translate/rotate 各 3 回以上
    expect(ctx.save).toHaveBeenCalledTimes(text.length)
    expect(ctx.restore).toHaveBeenCalledTimes(text.length)
    expect(ctx.translate).toHaveBeenCalledTimes(text.length)
    expect(ctx.rotate).toHaveBeenCalledTimes(text.length)
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

// ── issue #192: 低信頼ハイライト (赤系 fillRect) ──────────────────────────
describe('PdfCanvas static layer – low-confidence highlight (#192)', () => {
  it('confidence が閾値以下 + showLowConfidenceHighlight=true → 赤系 fillStyle が設定される', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '', confidence: 0.5 })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      0.7,   // threshold
      true,  // showLowConfidenceHighlight
    )

    // fillStyle が赤系 rgba(220, 38, 38, ...) で設定されたことを確認
    expect(ctx.fillStyle).toMatch(/rgba\(220,\s*38,\s*38/)
  })

  it('confidence が閾値より高い → 青系 fillStyle が設定される', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '', confidence: 0.9 })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      0.7,
      true,
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('showLowConfidenceHighlight=false のとき低信頼でも青系 fillStyle になる', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '', confidence: 0.3 })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      0.7,
      false, // OFF
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('confidence が undefined のとき低信頼でも青系 fillStyle になる (legacy)', () => {
    const ctx = makeMockContext()
    const block = makeBlock({ text: '', confidence: undefined })

    drawStaticBlock(
      ctx as unknown as CanvasRenderingContext2D,
      block,
      1,
      0.5,
      undefined,
      undefined,
      0.7,
      true,
    )

    expect(ctx.fillStyle).toMatch(/rgba\(0,\s*150,\s*255/)
  })

  it('renderStaticLayer 経由でも低信頼ブロックに赤系が設定される', () => {
    const ctx = makeMockContext()
    const canvas = makeMockCanvas()
    const block = makeBlock({ text: '', confidence: 0.4 })

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
      0.7,
      true,
    )

    expect(ctx.fillStyle).toMatch(/rgba\(220,\s*38,\s*38/)
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
