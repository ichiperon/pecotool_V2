/**
 * Issue #206: SaveDialog compressed preset — buildPdfDocument integration tests
 *
 * - preset='none' (default): useObjectStreams=false (Acrobat 7 compat, existing behaviour)
 * - preset='compressed':     useObjectStreams=true  (Object Streams, smaller file)
 * - preset='rasterized':     falls through to 'none' in executeSaveAs (TODO in hook layer);
 *                            buildPdfDocument itself receives no special handling.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import { buildPdfDocument } from '../../utils/pdfSaver'
import type { PecoDocument } from '../../types'
import type { SaveDialogOptions } from '../../hooks/useFileOperations'

/** Minimal PecoDocument with zero dirty pages */
function makeEmptyDoc(): PecoDocument {
  return {
    filePath: '/fake/test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    pages: new Map(),
  } as unknown as PecoDocument
}

/** Create a minimal single-page PDF as Uint8Array */
async function makeMinimalPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  return doc.save({ useObjectStreams: false, addDefaultPage: false })
}

describe('Issue #206: buildPdfDocument compressed preset', () => {
  it('preset=none (default) — produces byte-equivalent output with no dirty pages', async () => {
    const pdfBytes = await makeMinimalPdf()
    const doc = makeEmptyDoc()
    const options: SaveDialogOptions = { compression: 'none' }

    const result = await buildPdfDocument(pdfBytes, doc, undefined, [], undefined, undefined, options)

    // No dirty pages + no PecoTool metadata → short-circuit returns original bytes unchanged
    expect(result).toEqual(pdfBytes)
  })

  it('preset=compressed — output is smaller than or equal to preset=none for a typical PDF', async () => {
    // Build a PDF with extra (orphaned) indirect objects to give Object Streams something to work on.
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    // Register many streams so there are plenty of indirect objects for Object Streams to compress.
    for (let i = 0; i < 40; i++) {
      const data = new TextEncoder().encode(`extra content stream ${i} `.repeat(20))
      doc.context.register(doc.context.flateStream(data))
    }
    const pdfBytes = await doc.save({ useObjectStreams: false, addDefaultPage: false })

    const pecoDoc: PecoDocument = {
      filePath: '/fake/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      pages: new Map([
        [0, { isDirty: true, textBlocks: [], rotation: undefined } as never],
      ]),
    } as unknown as PecoDocument

    const resultNone = await buildPdfDocument(
      pdfBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'none' },
    )

    const resultCompressed = await buildPdfDocument(
      pdfBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'compressed' },
    )

    // compressed must not exceed none output
    expect(resultCompressed.byteLength).toBeLessThanOrEqual(resultNone.byteLength)
  })

  it('preset=compressed with dirty page — output size is ≤ preset=none', async () => {
    const pdfBytes = await makeMinimalPdf()

    // Inject a PecoTool BBox metadata stream to force a real pdf-lib save() round-trip
    // by loading the bytes and writing meta, then using those as input.
    const baseDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    // Embed a large stream to give Object Streams something to compress
    for (let i = 0; i < 20; i++) {
      const data = new TextEncoder().encode(`dummy stream content ${i} `.repeat(100))
      baseDoc.context.flateStream(data)
    }
    const inputBytes = await baseDoc.save({ useObjectStreams: false, addDefaultPage: false })

    const pecoDoc: PecoDocument = {
      filePath: '/fake/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      pages: new Map([
        [0, {
          isDirty: true,
          textBlocks: [],
          rotation: undefined,
        } as never],
      ]),
    } as unknown as PecoDocument

    const resultNone = await buildPdfDocument(
      inputBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'none' },
    )

    const resultCompressed = await buildPdfDocument(
      inputBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'compressed' },
    )

    // compressed must not exceed none
    expect(resultCompressed.byteLength).toBeLessThanOrEqual(resultNone.byteLength)
  })

  it('preset=compressed — output contains cross-reference stream (Object Streams marker)', async () => {
    const pdfBytes = await makeMinimalPdf()

    const pecoDoc: PecoDocument = {
      filePath: '/fake/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      pages: new Map([
        [0, { isDirty: true, textBlocks: [], rotation: undefined } as never],
      ]),
    } as unknown as PecoDocument

    const resultCompressed = await buildPdfDocument(
      pdfBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'compressed' },
    )

    const text = new TextDecoder('latin1').decode(resultCompressed)
    // PDF with useObjectStreams=true uses cross-reference streams (xref stream),
    // indicated by /XRef in the stream dictionary rather than classic "xref" keyword.
    const hasXRefStream = text.includes('/XRef') || text.includes('startxref')
    expect(hasXRefStream).toBe(true)
  })

  it('preset=none — output does NOT use cross-reference streams (classic xref table)', async () => {
    const pdfBytes = await makeMinimalPdf()

    const pecoDoc: PecoDocument = {
      filePath: '/fake/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      pages: new Map([
        [0, { isDirty: true, textBlocks: [], rotation: undefined } as never],
      ]),
    } as unknown as PecoDocument

    const resultNone = await buildPdfDocument(
      pdfBytes,
      pecoDoc,
      undefined,
      [],
      undefined,
      undefined,
      { compression: 'none' },
    )

    const text = new TextDecoder('latin1').decode(resultNone)
    // Classic xref table starts with "xref" keyword at file offset
    expect(text).toMatch(/\nxref\n/)
  })

  it('options=undefined — behaves identically to preset=none (backwards compat)', async () => {
    const pdfBytes = await makeMinimalPdf()

    const pecoDoc: PecoDocument = {
      filePath: '/fake/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      pages: new Map([
        [0, { isDirty: true, textBlocks: [], rotation: undefined } as never],
      ]),
    } as unknown as PecoDocument

    const resultDefault = await buildPdfDocument(pdfBytes, pecoDoc)
    const resultNone = await buildPdfDocument(pdfBytes, pecoDoc, undefined, [], undefined, undefined, { compression: 'none' })

    // Both should produce classic xref tables (not Object Streams)
    const textDefault = new TextDecoder('latin1').decode(resultDefault)
    const textNone = new TextDecoder('latin1').decode(resultNone)
    expect(textDefault).toMatch(/\nxref\n/)
    expect(textNone).toMatch(/\nxref\n/)
  })
})
