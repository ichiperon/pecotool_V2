/**
 * Acrobat 7.0 互換性監査テスト
 *
 * 検証項目（@cantoo/pdf-lib は実物、モック無し）:
 *  (1) useObjectStreams: false が効いているか (/ObjStm / XRef stream が出力に無い)
 *  (2) update: true の増分更新が効いているか (末尾追記、オリジナルが先頭に保持)
 *  (3) PDF version 行が元ファイルの版を維持しているか (%PDF-1.6)
 *  (4) drawText の出力が BT...ET の内部に正しく囲まれているか
 *
 * 監査対象は src/utils/pdfSaver.ts の buildPdfDocument（main thread path）。
 * 注記: Worker path (src/utils/pdf.worker.ts) には restorePdfVersion() による
 *       PDF header 補正が実装されているが、buildPdfDocument には無い。
 *       この差異が (3) の不合格要因になる。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, PDFRawStream, PDFName, PDFArray } from '@cantoo/pdf-lib'
import { inflate } from 'pako'
import { buildPdfDocument } from '../../utils/pdfSaver'
import type { PecoDocument, PageData, TextBlock } from '../../types'

const FONT_PATH = path.resolve(
  process.cwd(),
  'public/fonts/IPAexGothic.woff2',
)
const FONT_EXISTS = fs.existsSync(FONT_PATH)

/** version 1.6 の最小 PDF を作成する */
async function makeOriginalV16Pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  page.drawText('Original Hello', { x: 50, y: 800, size: 12 })
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false })
  // pdf-lib は header を内部で固定生成するため、バイト列先頭の version 文字を直接書き換える
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 10))
  if (!head.startsWith('%PDF-1.6')) {
    const patched = new Uint8Array(bytes)
    const enc = new TextEncoder().encode('%PDF-1.6')
    for (let i = 0; i < enc.length; i++) patched[i] = enc[i]
    return patched
  }
  return bytes
}

function makePecoDoc(): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text: FONT_EXISTS ? 'テスト漢字' : 'Hello World',
    originalText: '',
    bbox: { x: 100, y: 100, width: 200, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: true,
    isDirty: true,
  }
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  }
  return {
    filePath: 'in-memory.pdf',
    fileName: 'in-memory.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  }
}

async function extractAllContentStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false })
  const parts: string[] = []
  const dec = new TextDecoder('latin1')
  for (const page of doc.getPages()) {
    const contents = (page.node as unknown as {
      Contents(): unknown
    }).Contents()
    if (!contents) continue
    const resolved = doc.context.lookup(contents as never)
    const refs: unknown[] =
      resolved instanceof PDFArray
        ? (resolved.asArray() as unknown[])
        : [contents]
    for (const ref of refs) {
      const s = doc.context.lookup(ref as never)
      if (s instanceof PDFRawStream) {
        const filter = s.dict.lookup(PDFName.of('Filter'))
        const raw = s.getContents()
        let decoded: Uint8Array = raw
        if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
          try {
            decoded = inflate(raw)
          } catch {
            /* keep raw */
          }
        }
        parts.push(dec.decode(decoded))
      }
    }
  }
  return parts.join('\n---STREAM-BOUNDARY---\n')
}

describe('Acrobat 7.0 compatibility audit for buildPdfDocument', () => {
  let originalBytes: Uint8Array
  let savedBytes: Uint8Array
  let savedLatin1: string

  beforeAll(async () => {
    originalBytes = await makeOriginalV16Pdf()
    const pecoDoc = makePecoDoc()
    let fontBytes: ArrayBuffer | undefined
    if (FONT_EXISTS) {
      const nodeBuf = fs.readFileSync(FONT_PATH)
      const ab = new ArrayBuffer(nodeBuf.byteLength)
      new Uint8Array(ab).set(nodeBuf)
      fontBytes = ab
    }
    savedBytes = await buildPdfDocument(originalBytes, pecoDoc, fontBytes)
    savedLatin1 = new TextDecoder('latin1').decode(savedBytes)
    // 監査対象のメタ情報をログ
    // eslint-disable-next-line no-console
    console.log(
      '[audit] orig:',
      originalBytes.byteLength,
      'B head=',
      JSON.stringify(
        new TextDecoder('latin1').decode(originalBytes.slice(0, 8)),
      ),
      ' saved:',
      savedBytes.byteLength,
      'B head=',
      JSON.stringify(savedLatin1.slice(0, 8)),
      ' xref=',
      (savedLatin1.match(/\nxref\b/g) || []).length,
      ' trailer=',
      (savedLatin1.match(/\ntrailer\b/g) || []).length,
      ' %%EOF=',
      savedLatin1.split('%%EOF').length - 1,
    )
  })

  it('(1) useObjectStreams:false 検証: /ObjStm と XRef stream が出力に存在しない', () => {
    expect(savedLatin1).not.toMatch(/\/ObjStm\b/)
    expect(savedLatin1).not.toMatch(/\/Type\s*\/XRef\b/)
  })

  it('(2) 増分更新検証: オリジナルバイト列が先頭に保持され、末尾に追加 xref/trailer/EOF', () => {
    // オリジナル先頭 N バイトとの一致率
    let matchLen = 0
    const limit = originalBytes.byteLength
    for (let i = 0; i < limit && i < savedBytes.byteLength; i++) {
      if (savedBytes[i] !== originalBytes[i]) break
      matchLen++
    }
    const matchRatio = matchLen / limit
    // 真の増分更新なら 100% 近く一致するはず
    expect(matchRatio).toBeGreaterThan(0.95)

    // xref, trailer, %%EOF が 2 回以上出現する (増分セクション分)
    const xrefCount = (savedLatin1.match(/\nxref\b/g) || []).length
    const trailerCount = (savedLatin1.match(/\ntrailer\b/g) || []).length
    const eofCount = savedLatin1.split('%%EOF').length - 1
    expect(xrefCount).toBeGreaterThanOrEqual(2)
    expect(trailerCount).toBeGreaterThanOrEqual(2)
    expect(eofCount).toBeGreaterThanOrEqual(2)

    // 最後の %%EOF が末尾付近
    const lastEofIdx = savedLatin1.lastIndexOf('%%EOF')
    const tail = savedLatin1.slice(lastEofIdx + 5)
    expect(tail.trim()).toBe('')
  })

  it('(3) PDF version 維持検証: %PDF-1.6 のまま変更されていない', () => {
    expect(savedLatin1.startsWith('%PDF-1.6')).toBe(true)
  })

  it('(4) BT...ET 囲い検証: すべての Tj / TJ が BT と ET の間にある', async () => {
    const allContent = await extractAllContentStreams(savedBytes)
    const hasTextShow = /\bTj\b|\bTJ\b/.test(allContent)
    expect(hasTextShow).toBe(true)

    const tokenRegex = /\b(BT|ET|Tj|TJ)\b/g
    let lastOpen: 'BT' | 'ET' | null = null
    let m: RegExpExecArray | null
    const violations: string[] = []
    while ((m = tokenRegex.exec(allContent)) !== null) {
      const tok = m[1]
      if (tok === 'BT') lastOpen = 'BT'
      else if (tok === 'ET') lastOpen = 'ET'
      else if (tok === 'Tj' || tok === 'TJ') {
        if (lastOpen !== 'BT') {
          const ctx = allContent.slice(
            Math.max(0, m.index - 40),
            Math.min(allContent.length, m.index + 10),
          )
          violations.push(
            `text-show "${tok}" at ${m.index} outside BT..ET: ...${ctx}...`,
          )
        }
      }
    }
    expect(violations).toEqual([])
  })
})
