/**
 * GitHub Issue #96 リグレッションテスト
 *
 * OCR 校正で PDF が 10 倍に膨れる問題に対する 3 つの修正を回帰検証する:
 *  - Fix 1: PecoTool 生成フォントキー識別の堅牢化 (pdfPecoToolMarkers.ts)
 *  - Fix 2: 空 q-Q グラフィックスステートブロックの除去 (pdfContentStream.ts)
 *  - Fix 3: 到達可能性ベース GC スイープ (pdfReachabilityGc.ts)
 *  - 統合: 膨れた PDF を buildPdfDocument で再保存 → 原本級サイズへ収束 (要件2)
 */
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, PDFName, PDFDict, PDFArray } from '@cantoo/pdf-lib'
import { stripTextBlocks } from '../../utils/pdfContentStream'
import {
  isPecoToolFontKey,
  isPecoToolGraphicsStateKey,
  PECO_FONT_KEY_TAG,
} from '../../utils/pdfPecoToolMarkers'
import { compactIndirectObjectNumbers, sweepUnreachableObjects } from '../../utils/pdfReachabilityGc'
import { buildPdfDocument } from '../../utils/pdfSaver'
import type { PecoDocument, PageData, TextBlock } from '../../types'

describe('Issue #96 PDF size regression', () => {
  // -------------------------------------------------------------------------
  // Test 1: Fix 2 — stripTextBlocks が空 q-Q ラッパーを除去する
  // -------------------------------------------------------------------------
  describe('Fix 2: stripTextBlocks empty q-Q removal', () => {
    it('removes empty q-Q wrappers accumulated from previous saves', () => {
      // 「過去の OCR 保存で残った空ブロック」を模した content stream
      const stream = new TextEncoder().encode(
        'q\n1 0 0 1 100 200 cm\n1.5 0 0 0.83 0 0 cm\nq\n\nQ\nQ\n' +
          'q\n1 0 0 1 300 400 cm\n1.5 0 0 0.83 0 0 cm\nq\n\nQ\nQ\n' +
          'q\n1 0 0 1 50 50 cm\n/Im0 Do\nQ\n', // ← Do があるブロックは保持されるべき
      )
      const result = stripTextBlocks(stream)
      const out = new TextDecoder().decode(result)
      // 空ブロックは消える
      expect(out).not.toMatch(/100 200 cm/)
      expect(out).not.toMatch(/300 400 cm/)
      // 描画ありブロックは残る
      expect(out).toMatch(/\/Im0 Do/)
    })

    it('is idempotent (re-applying yields the same bytes)', () => {
      const stream = new TextEncoder().encode('q\nBT\n(hello) Tj\nET\nQ\n')
      const once = stripTextBlocks(stream)
      const twice = stripTextBlocks(once)
      expect(Array.from(twice)).toEqual(Array.from(once))
    })
  })

  // -------------------------------------------------------------------------
  // Test 2: Fix 1 — PecoTool フォント / GState キーの判定
  // -------------------------------------------------------------------------
  describe('Fix 1: PecoTool font / graphics-state key detection', () => {
    it('isPecoToolFontKey detects PECO_FONT_KEY_TAG prefix', () => {
      expect(isPecoToolFontKey(PDFName.of(`${PECO_FONT_KEY_TAG}-12345`))).toBe(true)
    })

    it('isPecoToolFontKey detects legacy prefixes including Meiryo (issue #96)', () => {
      expect(isPecoToolFontKey(PDFName.of('Meiryo-9742682568'))).toBe(true)
      expect(isPecoToolFontKey(PDFName.of('IPAexGothic-12345'))).toBe(true)
      expect(isPecoToolFontKey(PDFName.of('NotoSans-9999'))).toBe(true)
    })

    it('isPecoToolFontKey does NOT match non-PecoTool fonts (preserves original)', () => {
      expect(isPecoToolFontKey(PDFName.of('F1'))).toBe(false)
      expect(isPecoToolFontKey(PDFName.of('Helvetica'))).toBe(false)
      // 原本のサブセット埋め込みフォント — 誤検出されないこと
      expect(isPecoToolFontKey(PDFName.of('AAAAAA+MS-Gothic-0'))).toBe(false)
    })

    it('isPecoToolGraphicsStateKey detects /GS-N keys', () => {
      expect(isPecoToolGraphicsStateKey(PDFName.of('GS-0'))).toBe(true)
      expect(isPecoToolGraphicsStateKey(PDFName.of('GS-99'))).toBe(true)
      expect(isPecoToolGraphicsStateKey(PDFName.of('F1'))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Test 3: Fix 3 — sweepUnreachableObjects (issue #96 要件2 の核心)
  // -------------------------------------------------------------------------
  describe('Fix 3: sweepUnreachableObjects reachability GC', () => {
    it('drops unreachable streams (issue #96 requirement 2)', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])

      // 孤児ストリームを意図的に作る ("q\nQ\n" 相当)
      const garbage1 = doc.context.flateStream(new Uint8Array([113, 10, 81, 10]))
      const garbage2 = doc.context.flateStream(new Uint8Array([113, 10, 81, 10]))
      const garbage3 = doc.context.flateStream(new Uint8Array([113, 10, 81, 10]))
      const orphanRef1 = doc.context.register(garbage1)
      const orphanRef2 = doc.context.register(garbage2)
      const orphanRef3 = doc.context.register(garbage3)
      // どこからも参照されていないので、これらは孤児

      const before = doc.context.enumerateIndirectObjects().length
      const result = sweepUnreachableObjects(doc)
      const after = doc.context.enumerateIndirectObjects().length

      expect(result.dropped).toBeGreaterThanOrEqual(3)
      expect(after).toBeLessThan(before)
      // 孤児が確実に消えていること
      const allRefs = new Set(
        doc.context.enumerateIndirectObjects().map(([r]) => r.toString()),
      )
      expect(allRefs.has(orphanRef1.toString())).toBe(false)
      expect(allRefs.has(orphanRef2.toString())).toBe(false)
      expect(allRefs.has(orphanRef3.toString())).toBe(false)
    })

    it('preserves reachable objects (page tree, catalog, info)', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      doc.addPage([595, 842])

      sweepUnreachableObjects(doc)

      // 2 ページが残っていること
      expect(doc.getPageCount()).toBe(2)
      // save できること (壊れていない)
      const bytes = await doc.save({ useObjectStreams: false })
      expect(bytes.byteLength).toBeGreaterThan(0)
    })

    it('returns dropped 0 when trailerInfo.Root is missing', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      doc.context.register(doc.context.flateStream(new Uint8Array([113, 10, 81, 10])))
      const trailerInfo = (doc.context as any).trailerInfo
      trailerInfo.Root = undefined

      const before = doc.context.enumerateIndirectObjects().length
      const result = sweepUnreachableObjects(doc)
      const after = doc.context.enumerateIndirectObjects().length

      expect(result.dropped).toBe(0)
      expect(after).toBe(before)
    })

    it('expands shared direct objects only once', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      const shared = doc.context.obj({ Marker: PDFName.of('Shared') }) as PDFDict
      const entriesSpy = vi.spyOn(shared, 'entries')

      doc.catalog.set(PDFName.of('PecoSharedA'), shared)
      doc.catalog.set(PDFName.of('PecoSharedB'), shared)

      sweepUnreachableObjects(doc)

      expect(entriesSpy).toHaveBeenCalledTimes(1)
    })

    it('compacts object numbers and rewrites refs after GC gaps', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      const gapRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Gap') }) as PDFDict)
      const liveRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Live') }) as PDFDict)
      doc.catalog.set(PDFName.of('LiveRef'), liveRef)
      doc.context.delete(gapRef)

      const result = compactIndirectObjectNumbers(doc)
      const refs = doc.context.enumerateIndirectObjects().map(([ref]) => ref.objectNumber)

      expect(result.renumbered).toBeGreaterThan(0)
      expect(refs).toEqual(refs.map((_, index) => index + 1))
      expect((doc.context as any).largestObjectNumber).toBe(refs.length)
      const rewrittenLiveRef = doc.catalog.get(PDFName.of('LiveRef')) as typeof liveRef
      expect(rewrittenLiveRef.objectNumber).toBeLessThan(liveRef.objectNumber)
    })

    it('rewrites indirect objects whose value is a PDFRef', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      const gapRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Gap') }) as PDFDict)
      const targetRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Target') }) as PDFDict)
      const aliasObjectRef = doc.context.register(targetRef)
      doc.catalog.set(PDFName.of('Target'), targetRef)
      doc.catalog.set(PDFName.of('AliasObject'), aliasObjectRef)
      doc.context.delete(gapRef)

      compactIndirectObjectNumbers(doc)

      const rewrittenTarget = doc.catalog.get(PDFName.of('Target'))
      const rewrittenAliasObject = doc.catalog.get(PDFName.of('AliasObject'))
      const aliasValue = doc.context.lookup(rewrittenAliasObject as never)
      expect(aliasValue?.toString()).toBe(rewrittenTarget?.toString())
    })

    it('rewrites refs inside direct trailer objects', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      const gapRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Gap') }) as PDFDict)
      const liveRef = doc.context.register(doc.context.obj({ Marker: PDFName.of('Live') }) as PDFDict)
      doc.catalog.set(PDFName.of('LiveRef'), liveRef)
      ;(doc.context as any).trailerInfo.ID = doc.context.obj([liveRef])
      doc.context.delete(gapRef)

      compactIndirectObjectNumbers(doc)

      const rewrittenLiveRef = doc.catalog.get(PDFName.of('LiveRef'))
      const trailerId = (doc.context as any).trailerInfo.ID as PDFArray
      expect(trailerId.get(0)?.toString()).toBe(rewrittenLiveRef?.toString())
    })
  })

  // -------------------------------------------------------------------------
  // Test T3 (Add): フォントキー判定の境界条件 (review finding)
  // -------------------------------------------------------------------------
  describe('Fix 1: isPecoToolFontKey boundary conditions', () => {
    it('rejects similar-prefix-but-not-PecoTool keys', () => {
      // /PecoF (ハイフン無し) は false — PECO_FONT_KEY_TAG は `${tag}-` で始まる必要がある
      expect(isPecoToolFontKey(PDFName.of('PecoF'))).toBe(false)
      // /PecoFood-123 (PecoF で始まる別の名前) は false
      expect(isPecoToolFontKey(PDFName.of('PecoFood-123'))).toBe(false)
      // /AAAAAA+Meiryo-Identity-H (subset 接頭辞付き原本) は false
      expect(isPecoToolFontKey(PDFName.of('AAAAAA+Meiryo-Identity-H'))).toBe(false)
      // /Meiryo-Bold (原本由来の Bold variant) — コード側で数値サフィックス限定に
      // なれば false。現状の startsWith('/Meiryo-') 実装では true になる可能性あり。
      // この assertion は別エージェントが pdfPecoToolMarkers.ts を厳格化した後に
      // 期待通り pass する。コード未修正の段階では失敗してもよい（後で確認する仕様）。
      expect(isPecoToolFontKey(PDFName.of('Meiryo-Bold'))).toBe(false)
      // /Meiryo-9742682568 (PecoTool 旧版生成の数値サフィックス付き) は true 維持
      expect(isPecoToolFontKey(PDFName.of('Meiryo-9742682568'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Test T2 (Add): 循環参照のGC — 無限ループしないこと
  // -------------------------------------------------------------------------
  describe('Fix 3: sweepUnreachableObjects orphan cycle handling', () => {
    it('handles orphan cycles without infinite loop and drops all', async () => {
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])

      // A → B → A の循環参照を持つ孤児ペアを作る
      const dictA = doc.context.obj({}) as PDFDict
      const dictB = doc.context.obj({}) as PDFDict
      const refA = doc.context.register(dictA)
      const refB = doc.context.register(dictB)
      dictA.set(PDFName.of('Sibling'), refB)
      dictB.set(PDFName.of('Sibling'), refA)
      // /Root から到達できないので、両方が孤児

      // BFS が visited セットでガードされていれば無限ループしない
      const result = sweepUnreachableObjects(doc)
      expect(result.dropped).toBeGreaterThanOrEqual(2)

      // 孤児リファレンスが消えていること
      const allRefs = new Set(
        doc.context.enumerateIndirectObjects().map(([r]) => r.toString()),
      )
      expect(allRefs.has(refA.toString())).toBe(false)
      expect(allRefs.has(refB.toString())).toBe(false)

      // /Root 配下のページは無事
      expect(doc.getPageCount()).toBe(1)
      const bytes = await doc.save({ useObjectStreams: false })
      expect(bytes.byteLength).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Test T1 (Add Critical): 10 回保存 saturation テスト (acceptance #2)
  // -------------------------------------------------------------------------
  describe('Fix 1+3 integrated: successive-save saturation (acceptance #2)', () => {
    it('10 successive saves do not exceed 1.5x initial size', async () => {
      // 合成 PDF を作成
      const baseline = await PDFDocument.create()
      baseline.addPage([595, 842])
      baseline.addPage([595, 842])
      const baselineBytes = await baseline.save({ useObjectStreams: false })

      const sizes: number[] = []
      let currentBytes: Uint8Array = baselineBytes
      for (let i = 0; i < 10; i++) {
        const block: TextBlock = {
          id: `b-${i}`,
          text: `iteration ${i}`,
          originalText: `iteration ${i}`,
          bbox: { x: 10, y: 10, width: 100, height: 20 },
          writingMode: 'horizontal',
          order: 0,
          isNew: false,
          isDirty: true,
        }
        const page0: PageData = {
          pageIndex: 0,
          width: 595,
          height: 842,
          textBlocks: [block],
          isDirty: true,
          thumbnail: null,
        }
        const documentState: PecoDocument = {
          fileName: 'test.pdf',
          filePath: '/tmp/test.pdf',
          totalPages: 2,
          metadata: {},
          pages: new Map([[0, page0]]),
        }
        currentBytes = await buildPdfDocument(currentBytes, documentState)
        sizes.push(currentBytes.byteLength)
      }
      // 10 回目のサイズが 1 回目の 1.5 倍以下（孤児/フォント重複が累積していない）
      expect(sizes[9]).toBeLessThan(sizes[0] * 1.5)
    })

    it('10 saves do not accumulate duplicate Font dict entries on a page', async () => {
      // T5: ページの /Resources/Font 辞書のキー数が 10 回後も増殖していないこと
      const baseline = await PDFDocument.create()
      baseline.addPage([595, 842])
      const baselineBytes = await baseline.save({ useObjectStreams: false })

      let currentBytes: Uint8Array = baselineBytes
      for (let i = 0; i < 10; i++) {
        const block: TextBlock = {
          id: `b-${i}`,
          text: `iteration ${i}`,
          originalText: `iteration ${i}`,
          bbox: { x: 10, y: 10, width: 100, height: 20 },
          writingMode: 'horizontal',
          order: 0,
          isNew: false,
          isDirty: true,
        }
        const page0: PageData = {
          pageIndex: 0,
          width: 595,
          height: 842,
          textBlocks: [block],
          isDirty: true,
          thumbnail: null,
        }
        const documentState: PecoDocument = {
          fileName: 'test.pdf',
          filePath: '/tmp/test.pdf',
          totalPages: 1,
          metadata: {},
          pages: new Map([[0, page0]]),
        }
        currentBytes = await buildPdfDocument(currentBytes, documentState)
      }

      // 最終的な Font 辞書のキー数を計測
      const finalDoc = await PDFDocument.load(currentBytes)
      const page = finalDoc.getPage(0)
      const resources = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.()
      const fontDict = resources?.lookup(PDFName.of('Font'))
      if (fontDict instanceof PDFDict) {
        const fontKeyCount = Array.from(fontDict.entries()).length
        // PecoTool は 1 ページにつき 1 Font key (PecoF-xxx) しか生成しないはず。
        // 旧版バグでは毎回保存ごとにキーが増殖していた。緩く 4 以下を許容。
        expect(fontKeyCount).toBeLessThanOrEqual(4)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Test 4: 統合 — 膨れた PDF → buildPdfDocument → 原本級サイズへ収束
  // -------------------------------------------------------------------------
  describe('Fix 1+2+3 integrated: bloated PDF converges to baseline size', () => {
    it('bloated PDF (with orphans) shrinks back to baseline after re-save', async () => {
      // 1) 通常の小さな PDF (baseline) を作る
      const baseline = await PDFDocument.create()
      baseline.addPage([595, 842])
      const baselineBytes = await baseline.save({ useObjectStreams: false })

      // 2) これに孤児オブジェクトを大量注入して「膨れた PDF」を作る
      const bloated = await PDFDocument.load(baselineBytes)
      for (let i = 0; i < 50; i++) {
        // それぞれ約 1KB の孤児ストリーム (FlateDecode で多少縮むが原寸でも比較可能)
        const garbage = bloated.context.flateStream(new Uint8Array(1024).fill(65))
        bloated.context.register(garbage)
      }
      const bloatedBytes = await bloated.save({ useObjectStreams: false })
      // 膨れているはず
      expect(bloatedBytes.byteLength).toBeGreaterThan(baselineBytes.byteLength * 1.5)

      // 3) buildPdfDocument で再保存 (dirty page なし → pure GC sweep のみ実行される経路)
      const emptyDocState: PecoDocument = {
        filePath: 'test.pdf',
        fileName: 'test.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      }
      const cleaned = await buildPdfDocument(bloatedBytes, emptyDocState)

      // 4) 原本級のサイズに戻っていること
      expect(cleaned.byteLength).toBeLessThan(baselineBytes.byteLength * 1.3)
    })
  })
})
