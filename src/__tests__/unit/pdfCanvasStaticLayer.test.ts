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
 */
import { describe, it, expect, vi } from 'vitest'

// PdfCanvas は import 連鎖で pdfjs-dist を読み込み jsdom 上で DOMMatrix エラーを
// 起こすため、helper だけを取り出すのに必要な subset を mock する。
vi.mock('pdfjs-dist', () => ({ default: {} }))
vi.mock('../../utils/pdfLoader', () => ({ getCachedPageProxy: vi.fn() }))

import { drawStaticBlock, renderStaticLayer } from '../../components/PdfCanvas'
import type { TextBlock } from '../../types'

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
