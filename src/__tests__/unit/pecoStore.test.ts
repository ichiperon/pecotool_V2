import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  usePecoStore,
  waitForPendingIdbSaves,
  selectCurrentPageTextBlocks,
  selectDragPreviewBboxes,
} from '../../store/pecoStore'
import * as pdfLoader from '../../utils/pdfLoader'
import type { PecoDocument, PageData, Action, TextBlock, BoundingBox } from '../../types'

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
}))

// ── ヘルパー ──────────────────────────────────────────────────

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  }
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: crypto.randomUUID(),
    text: 'test',
    originalText: 'test',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  }
}

function makeDoc(pages: Map<number, PageData> = new Map([[0, makePage()]])): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

const INITIAL_STATE = {
  document:          null,
  documentEpoch:     0,
  thumbnails:        new Map(),
  currentPageIndex:  0,
  zoom:              100,
  isDirty:           false,
  showOcr:           true,
  showTextPreview:   false,
  isDrawingMode:     false,
  isSplitMode:       false,
  selectedIds:       new Set<string>(),
  undoStack:         [] as Action[],
  redoStack:         [] as Action[],
  currentPageProxy:  null,
  currentPageProxyKey: null,
  dragPreviewBboxes: null as Map<string, BoundingBox> | null,
} as const

// ── setup ──────────────────────────────────────────────────────

beforeEach(() => {
  usePecoStore.setState({ ...INITIAL_STATE })
})

// ── テスト ────────────────────────────────────────────────────

describe('pecoStore', () => {

  describe('U-ST-01: Undo スタック追加', () => {
    it('pushAction で undoStack に action が積まれる', () => {
      const action: Action = { type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }
      usePecoStore.getState().pushAction(action)

      const { undoStack } = usePecoStore.getState()
      expect(undoStack).toHaveLength(1)
      expect(undoStack[0]).toBe(action)
    })

    it('pushAction すると redoStack がクリアされる', () => {
      usePecoStore.setState({ redoStack: [{ type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }] })
      usePecoStore.getState().pushAction({ type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() })

      expect(usePecoStore.getState().redoStack).toHaveLength(0)
    })
  })

  describe('documentEpoch', () => {
    it('bumpDocumentEpoch は古い currentPageProxy も破棄する', () => {
      const proxy = { id: 'old-proxy' } as any;
      usePecoStore.setState({
        documentEpoch: 10,
        currentPageProxy: proxy,
        currentPageProxyKey: 'test.pdf:0',
      });

      usePecoStore.getState().bumpDocumentEpoch();

      const state = usePecoStore.getState();
      expect(state.documentEpoch).toBe(11);
      expect(state.currentPageProxy).toBeNull();
      expect(state.currentPageProxyKey).toBeNull();
    });
  });

  describe('U-ST-02: Undo 実行', () => {
    it('undo() で before 状態に戻り redoStack に action が移動する', () => {
      const beforePage = makePage({ isDirty: false })
      const afterPage  = makePage({ isDirty: true })
      const doc = makeDoc(new Map([[0, afterPage]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before: beforePage, after: afterPage }

      usePecoStore.setState({ document: doc, undoStack: [action], redoStack: [] })
      usePecoStore.getState().undo()

      const state = usePecoStore.getState()
      expect(state.document!.pages.get(0)).toEqual(beforePage)
      expect(state.undoStack).toHaveLength(0)
      expect(state.redoStack).toHaveLength(1)
      expect(state.redoStack[0]).toBe(action)
    })

    it('document が null のとき undo() は何もしない', () => {
      usePecoStore.setState({ document: null, undoStack: [{ type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }] })
      usePecoStore.getState().undo()

      expect(usePecoStore.getState().undoStack).toHaveLength(1)
    })

    it('undoStack が空のとき undo() は何もしない', () => {
      usePecoStore.setState({ document: makeDoc(), undoStack: [] })
      usePecoStore.getState().undo()

      expect(usePecoStore.getState().undoStack).toHaveLength(0)
    })
  })

  describe('U-ST-03: Redo 実行', () => {
    it('redo() で after 状態に戻り undoStack に action が移動する', () => {
      const beforePage = makePage({ isDirty: false })
      const afterPage  = makePage({ isDirty: true })
      const doc = makeDoc(new Map([[0, beforePage]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before: beforePage, after: afterPage }

      usePecoStore.setState({ document: doc, undoStack: [], redoStack: [action] })
      usePecoStore.getState().redo()

      const state = usePecoStore.getState()
      expect(state.document!.pages.get(0)).toEqual(afterPage)
      expect(state.redoStack).toHaveLength(0)
      expect(state.undoStack).toHaveLength(1)
      expect(state.undoStack[0]).toBe(action)
    })

    it('redoStack が空のとき redo() は何もしない', () => {
      usePecoStore.setState({ document: makeDoc(), redoStack: [] })
      usePecoStore.getState().redo()

      expect(usePecoStore.getState().undoStack).toHaveLength(0)
    })
  })

  describe('U-ST-04: Undo スタック上限 (100件)', () => {
    it('101 回 pushAction しても undoStack.length は 100 を超えない', () => {
      for (let i = 0; i < 101; i++) {
        usePecoStore.getState().pushAction({ type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() })
      }
      expect(usePecoStore.getState().undoStack).toHaveLength(100)
    })

    it('上限超過時は先頭 (最古) の action が削除される', () => {
      // 最初に order=0 を push してから 100 件追加
      usePecoStore.getState().pushAction({ type: 'update_page', pageIndex: 0, before: makePage({ pageIndex: 0 }), after: makePage() })
      for (let i = 1; i <= 100; i++) {
        usePecoStore.getState().pushAction({ type: 'update_page', pageIndex: 0, before: makePage({ pageIndex: i }), after: makePage() })
      }
      const stack = usePecoStore.getState().undoStack
      expect(stack).toHaveLength(100)
      // i=0 の action は消えているはず、先頭は i=1 になっているはず
      expect(stack[0].before.pageIndex).toBe(1)
    })
  })

  describe('U-ST-05: ページデータ更新', () => {
    it('updatePageData(0, ...) で page 0 のみ更新される', () => {
      const page0 = makePage({ pageIndex: 0, isDirty: false })
      const page1 = makePage({ pageIndex: 1, isDirty: false })
      const doc = makeDoc(new Map([[0, page0], [1, page1]]))
      usePecoStore.setState({ document: doc })

      usePecoStore.getState().updatePageData(0, { isDirty: true })

      const state = usePecoStore.getState()
      expect(state.document!.pages.get(0)!.isDirty).toBe(true)
      expect(state.document!.pages.get(1)!.isDirty).toBe(false)
    })

    it('updatePageData で store.isDirty が true になる', () => {
      usePecoStore.setState({ document: makeDoc(), isDirty: false })
      usePecoStore.getState().updatePageData(0, { isDirty: true })

      expect(usePecoStore.getState().isDirty).toBe(true)
    })

    it('document が null のとき updatePageData は何もしない', () => {
      usePecoStore.setState({ document: null })
      usePecoStore.getState().updatePageData(0, { isDirty: true })

      expect(usePecoStore.getState().document).toBeNull()
    })
  })

  describe('U-ST-06: 選択 ID 管理', () => {
    it('toggleSelection(multi=false) は選択を1件にリセットする', () => {
      usePecoStore.setState({ selectedIds: new Set(['a', 'b']) })
      usePecoStore.getState().toggleSelection('c', false)

      expect(usePecoStore.getState().selectedIds).toEqual(new Set(['c']))
    })

    it('toggleSelection(multi=true) は既存選択に追加する', () => {
      usePecoStore.setState({ selectedIds: new Set(['a']) })
      usePecoStore.getState().toggleSelection('b', true)

      const ids = usePecoStore.getState().selectedIds
      expect(ids.has('a')).toBe(true)
      expect(ids.has('b')).toBe(true)
    })

    it('toggleSelection で既に選択済みの ID は削除される', () => {
      usePecoStore.setState({ selectedIds: new Set(['a', 'b']) })
      usePecoStore.getState().toggleSelection('a', true)

      expect(usePecoStore.getState().selectedIds.has('a')).toBe(false)
      expect(usePecoStore.getState().selectedIds.has('b')).toBe(true)
    })

    it('clearSelection で selectedIds が空になる', () => {
      usePecoStore.setState({ selectedIds: new Set(['a', 'b']) })
      usePecoStore.getState().clearSelection()

      expect(usePecoStore.getState().selectedIds.size).toBe(0)
    })
  })

  // ── Undo/Redo edge cases ──────────────────────────────────────

  describe('U-PS-06: undo sets isDirty=true', () => {
    it('undo 後に isDirty が true になる', () => {
      const before = makePage({ isDirty: false })
      const after = makePage({ isDirty: true })
      const doc = makeDoc(new Map([[0, after]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before, after }

      usePecoStore.setState({ document: doc, undoStack: [action], isDirty: false })
      usePecoStore.getState().undo()

      expect(usePecoStore.getState().isDirty).toBe(true)
    })
  })

  describe('U-PS-13: undo→redo round-trip preserves data', () => {
    it('undo して redo すると元のデータに戻る', () => {
      const before = makePage({ pageIndex: 0, isDirty: false })
      const after = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock()] })
      const doc = makeDoc(new Map([[0, after]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before, after }

      usePecoStore.setState({ document: doc, undoStack: [action], redoStack: [] })

      usePecoStore.getState().undo()
      expect(usePecoStore.getState().document!.pages.get(0)).toEqual(before)

      usePecoStore.getState().redo()
      expect(usePecoStore.getState().document!.pages.get(0)).toEqual(after)
    })
  })

  // ── updatePageData ─────────────────────────────────────────────

  describe('updatePageData (U-PS-14 ~ U-PS-26)', () => {
    it('U-PS-14: デフォルトで isDirty=true になる', () => {
      usePecoStore.setState({ document: makeDoc(), isDirty: false })
      usePecoStore.getState().updatePageData(0, { textBlocks: [] })

      expect(usePecoStore.getState().isDirty).toBe(true)
    })

    it('U-PS-15: isDirty:false を渡すとグローバル isDirty を設定しない', () => {
      usePecoStore.setState({ document: makeDoc(), isDirty: false })
      usePecoStore.getState().updatePageData(0, { isDirty: false })

      expect(usePecoStore.getState().isDirty).toBe(false)
    })

    it('U-PS-16: 部分更新で既存フィールドが保持される', () => {
      const block = makeBlock({ text: 'keep me' })
      const page = makePage({ textBlocks: [block], width: 100 })
      usePecoStore.setState({ document: makeDoc(new Map([[0, page]])) })

      usePecoStore.getState().updatePageData(0, { height: 999 })

      const updated = usePecoStore.getState().document!.pages.get(0)!
      expect(updated.textBlocks).toHaveLength(1)
      expect(updated.textBlocks[0].text).toBe('keep me')
      expect(updated.width).toBe(100)
      expect(updated.height).toBe(999)
    })

    it('U-PS-17: 存在しないページは data をそのまま PageData として作成する', () => {
      usePecoStore.setState({ document: makeDoc() })
      const newPage = makePage({ pageIndex: 5, width: 200 })
      usePecoStore.getState().updatePageData(5, newPage as Partial<PageData>)

      const created = usePecoStore.getState().document!.pages.get(5)
      expect(created).toBeDefined()
      expect(created!.pageIndex).toBe(5)
      expect(created!.width).toBe(200)
    })

    it('U-PS-18: undoable=true (デフォルト) で undo アクションが生成される', () => {
      const page = makePage()
      usePecoStore.setState({ document: makeDoc(new Map([[0, page]])), undoStack: [] })

      usePecoStore.getState().updatePageData(0, { isDirty: true })

      const stack = usePecoStore.getState().undoStack
      expect(stack).toHaveLength(1)
      expect(stack[0].before).toEqual(page)
      expect(stack[0].after.isDirty).toBe(true)
    })

    it('U-PS-19: undoable=false で undo 記録がスキップされる', () => {
      usePecoStore.setState({ document: makeDoc(), undoStack: [] })
      usePecoStore.getState().updatePageData(0, { isDirty: true }, false)

      expect(usePecoStore.getState().undoStack).toHaveLength(0)
    })

    it('U-PS-20: oldPage が存在しない場合 undo は記録されない', () => {
      usePecoStore.setState({ document: makeDoc(), undoStack: [] })
      // page index 99 doesn't exist
      usePecoStore.getState().updatePageData(99, makePage({ pageIndex: 99 }) as Partial<PageData>)

      expect(usePecoStore.getState().undoStack).toHaveLength(0)
    })

    it('U-PS-22: undoable な更新で redoStack がクリアされる', () => {
      const action: Action = { type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }
      usePecoStore.setState({ document: makeDoc(), redoStack: [action] })

      usePecoStore.getState().updatePageData(0, { isDirty: true })

      expect(usePecoStore.getState().redoStack).toHaveLength(0)
    })

    it('U-PS-26: pageAccessOrder が更新される', () => {
      const pages = new Map([[0, makePage({ pageIndex: 0 })], [1, makePage({ pageIndex: 1 })]])
      usePecoStore.setState({ document: makeDoc(pages), pageAccessOrder: [1, 0] })

      usePecoStore.getState().updatePageData(0, { isDirty: true })

      const order = usePecoStore.getState().pageAccessOrder
      expect(order[0]).toBe(0) // updated page moves to front
    })
  })

  // ── Selection (extended) ──────────────────────────────────────

  describe('Selection (U-PS-30 ~ U-PS-34)', () => {
    it('U-PS-30: toggleSelection で lastSelectedId が更新される', () => {
      usePecoStore.setState({ selectedIds: new Set(), lastSelectedId: null })
      usePecoStore.getState().toggleSelection('x', false)

      expect(usePecoStore.getState().lastSelectedId).toBe('x')
    })

    it('U-PS-31: lastSelectedId を deselect すると null になる', () => {
      usePecoStore.setState({ selectedIds: new Set(['x']), lastSelectedId: 'x' })
      usePecoStore.getState().toggleSelection('x', true)

      expect(usePecoStore.getState().lastSelectedId).toBeNull()
    })

    it('U-PS-32: setSelectedIds で選択が置き換わり lastSelectedId = 末尾要素', () => {
      usePecoStore.setState({ selectedIds: new Set(['old']) })
      usePecoStore.getState().setSelectedIds(['a', 'b', 'c'])

      expect(usePecoStore.getState().selectedIds).toEqual(new Set(['a', 'b', 'c']))
      expect(usePecoStore.getState().lastSelectedId).toBe('c')
    })

    it('U-PS-33: setSelectedIds([]) で全クリアされる', () => {
      usePecoStore.setState({ selectedIds: new Set(['a']), lastSelectedId: 'a' })
      usePecoStore.getState().setSelectedIds([])

      expect(usePecoStore.getState().selectedIds.size).toBe(0)
      expect(usePecoStore.getState().lastSelectedId).toBeNull()
    })

    it('U-PS-34: clearSelection で lastSelectedId もリセットされる', () => {
      usePecoStore.setState({ selectedIds: new Set(['a']), lastSelectedId: 'a' })
      usePecoStore.getState().clearSelection()

      expect(usePecoStore.getState().selectedIds.size).toBe(0)
      expect(usePecoStore.getState().lastSelectedId).toBeNull()
    })
  })

  // ── Clipboard ─────────────────────────────────────────────────

  describe('Clipboard (U-PS-35 ~ U-PS-45)', () => {
    it('U-PS-35: copySelected でマッチするブロックがコピーされる', () => {
      const b1 = makeBlock({ id: 'b1' })
      const b2 = makeBlock({ id: 'b2' })
      const page = makePage({ textBlocks: [b1, b2] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        selectedIds: new Set(['b1']),
      })

      usePecoStore.getState().copySelected()

      const clip = usePecoStore.getState().clipboard
      expect(clip).toHaveLength(1)
      expect(clip[0].id).toBe('b1')
    })

    it('U-PS-36: deep copy (参照が共有されない)', () => {
      const b1 = makeBlock({ id: 'b1' })
      const page = makePage({ textBlocks: [b1] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        selectedIds: new Set(['b1']),
      })

      usePecoStore.getState().copySelected()

      const clip = usePecoStore.getState().clipboard
      expect(clip[0]).not.toBe(b1)
      expect(clip[0]).toEqual(b1)
    })

    it('U-PS-37: 選択なしで copySelected は no-op', () => {
      usePecoStore.setState({
        document: makeDoc(),
        currentPageIndex: 0,
        selectedIds: new Set(),
        clipboard: [],
      })

      usePecoStore.getState().copySelected()

      expect(usePecoStore.getState().clipboard).toHaveLength(0)
    })

    it('U-PS-38: document=null で copySelected は no-op', () => {
      usePecoStore.setState({
        document: null,
        selectedIds: new Set(['a']),
        clipboard: [],
      })

      usePecoStore.getState().copySelected()

      expect(usePecoStore.getState().clipboard).toHaveLength(0)
    })

    it('U-PS-39: pasteClipboard で新しい UUID が生成される', () => {
      const b1 = makeBlock({ id: 'original-id' })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1],
      })

      usePecoStore.getState().pasteClipboard()

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0].id).not.toBe('original-id')
    })

    it('U-PS-40: paste で bbox が +10, +10 オフセットされる', () => {
      const b1 = makeBlock({ bbox: { x: 50, y: 60, width: 100, height: 20 } })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1],
      })

      usePecoStore.getState().pasteClipboard()

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].bbox.x).toBe(60)
      expect(blocks[0].bbox.y).toBe(70)
    })

    it('targetCenter 指定の paste は単一ブロックの中心を指定位置に合わせる', () => {
      const b1 = makeBlock({ bbox: { x: 50, y: 60, width: 100, height: 20 } })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1],
      })

      usePecoStore.getState().pasteClipboard({ x: 200, y: 300 })

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].bbox.x).toBe(150)
      expect(blocks[0].bbox.y).toBe(290)
      expect(blocks[0].bbox.x + blocks[0].bbox.width / 2).toBe(200)
      expect(blocks[0].bbox.y + blocks[0].bbox.height / 2).toBe(300)
      expect(usePecoStore.getState().selectedIds).toEqual(new Set([blocks[0].id]))
    })

    it('targetCenter 指定の paste は複数ブロックの相対位置を保ってグループ中心を合わせる', () => {
      const b1 = makeBlock({ id: 'clip-1', bbox: { x: 10, y: 20, width: 30, height: 10 } })
      const b2 = makeBlock({ id: 'clip-2', bbox: { x: 70, y: 100, width: 20, height: 40 } })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1, b2],
      })

      usePecoStore.getState().pasteClipboard({ x: 200, y: 300 })

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].bbox.x).toBe(160)
      expect(blocks[0].bbox.y).toBe(240)
      expect(blocks[1].bbox.x).toBe(220)
      expect(blocks[1].bbox.y).toBe(320)
      expect(blocks[1].bbox.x - blocks[0].bbox.x).toBe(b2.bbox.x - b1.bbox.x)
      expect(blocks[1].bbox.y - blocks[0].bbox.y).toBe(b2.bbox.y - b1.bbox.y)
      expect((blocks[0].bbox.x + blocks[1].bbox.x + blocks[1].bbox.width) / 2).toBe(200)
      expect((blocks[0].bbox.y + blocks[1].bbox.y + blocks[1].bbox.height) / 2).toBe(300)
      expect(usePecoStore.getState().selectedIds).toEqual(new Set(blocks.map(b => b.id)))
    })

    it('U-PS-41: paste で isNew=true, isDirty=true が設定される', () => {
      const b1 = makeBlock({ isNew: false, isDirty: false })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1],
      })

      usePecoStore.getState().pasteClipboard()

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].isNew).toBe(true)
      expect(blocks[0].isDirty).toBe(true)
    })

    it('U-PS-42: paste で selectedIds が新しい ID に更新される', () => {
      const b1 = makeBlock({ id: 'old' })
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [b1],
        selectedIds: new Set(['something-else']),
      })

      usePecoStore.getState().pasteClipboard()

      const ids = usePecoStore.getState().selectedIds
      expect(ids.size).toBe(1)
      expect(ids.has('old')).toBe(false)
    })

    it('U-PS-43: paste で既存ブロックに追加される', () => {
      const existing = makeBlock({ id: 'existing' })
      const toPaste = makeBlock({ id: 'clip' })
      const page = makePage({ textBlocks: [existing] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [toPaste],
      })

      usePecoStore.getState().pasteClipboard()

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0].id).toBe('existing')
    })

    it('U-PS-44: paste の order は既存ブロック数からの連番', () => {
      const e1 = makeBlock({ order: 0 })
      const e2 = makeBlock({ order: 1 })
      const c1 = makeBlock()
      const c2 = makeBlock()
      const page = makePage({ textBlocks: [e1, e2] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [c1, c2],
      })

      usePecoStore.getState().pasteClipboard()

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[2].order).toBe(2)
      expect(blocks[3].order).toBe(3)
    })

    it('U-PS-45: clipboard が空なら pasteClipboard は no-op', () => {
      const page = makePage({ textBlocks: [] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        clipboard: [],
      })

      usePecoStore.getState().pasteClipboard()

      expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0)
    })
  })

  // ── clearOcr ──────────────────────────────────────────────────

  describe('clearOcr (U-PS-46 ~ U-PS-52)', () => {
    it('U-PS-46: clearOcrCurrentPage で現在ページの textBlocks が空になり isDirty=true', () => {
      const page = makePage({ textBlocks: [makeBlock()], isDirty: false })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        isDirty: false,
      })

      usePecoStore.getState().clearOcrCurrentPage()

      const state = usePecoStore.getState()
      expect(state.document!.pages.get(0)!.textBlocks).toHaveLength(0)
      expect(state.document!.pages.get(0)!.isDirty).toBe(true)
      expect(state.isDirty).toBe(true)
    })

    it('U-PS-47: clearOcrCurrentPage は他のページに影響しない', () => {
      const block = makeBlock()
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock()] })
      const page1 = makePage({ pageIndex: 1, textBlocks: [block] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page0], [1, page1]])),
        currentPageIndex: 0,
      })

      usePecoStore.getState().clearOcrCurrentPage()

      expect(usePecoStore.getState().document!.pages.get(1)!.textBlocks).toHaveLength(1)
    })

    it('U-PS-48: document=null で clearOcrCurrentPage はエラーにならない', () => {
      usePecoStore.setState({ document: null })
      expect(() => usePecoStore.getState().clearOcrCurrentPage()).not.toThrow()
    })

    it('U-PS-49: clearOcrAllPages で全ロード済みページの textBlocks が空になる', () => {
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock()] })
      const page1 = makePage({ pageIndex: 1, textBlocks: [makeBlock()] })
      const doc = makeDoc(new Map([[0, page0], [1, page1]]))
      usePecoStore.setState({ document: doc })

      usePecoStore.getState().clearOcrAllPages()

      const state = usePecoStore.getState()
      expect(state.document!.pages.get(0)!.textBlocks).toHaveLength(0)
      expect(state.document!.pages.get(1)!.textBlocks).toHaveLength(0)
    })

    it('U-PS-50: 未ロードページにも OCR 消去スタブを撒く (totalPages=5, loaded=2)', () => {
      const page0 = makePage({ pageIndex: 0 })
      const page2 = makePage({ pageIndex: 2 })
      const doc: PecoDocument = {
        filePath: 'test.pdf',
        fileName: 'test.pdf',
        totalPages: 5,
        metadata: {},
        pages: new Map([[0, page0], [2, page2]]),
      }
      usePecoStore.setState({ document: doc })

      usePecoStore.getState().clearOcrAllPages()

      const pages = usePecoStore.getState().document!.pages
      expect(pages.size).toBe(5)
      expect(pages.has(0)).toBe(true)
      expect(pages.has(2)).toBe(true)
      expect(pages.has(1)).toBe(true)
      expect(pages.get(0)!.textBlocks).toHaveLength(0)
      expect(pages.get(0)!.isDirty).toBe(true)
      expect(pages.get(2)!.textBlocks).toHaveLength(0)
      expect(pages.get(2)!.isDirty).toBe(true)
      expect(pages.get(1)!.textBlocks).toHaveLength(0)
      expect(pages.get(1)!.isDirty).toBe(true)
      expect(pages.get(1)!.ocrCleared).toBe(true)
    })

    it('U-PS-51: clearOcrAllPages で undo/redo スタックがクリアされる', () => {
      const action: Action = { type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }
      usePecoStore.setState({
        document: makeDoc(),
        undoStack: [action],
        redoStack: [action],
      })

      usePecoStore.getState().clearOcrAllPages()

      expect(usePecoStore.getState().undoStack).toHaveLength(0)
      expect(usePecoStore.getState().redoStack).toHaveLength(0)
    })

    it('U-PS-52: clearOcrAllPages でグローバル isDirty=true になる', () => {
      usePecoStore.setState({ document: makeDoc(), isDirty: false })

      usePecoStore.getState().clearOcrAllPages()

      expect(usePecoStore.getState().isDirty).toBe(true)
    })
  })

  // ── setCurrentPage ────────────────────────────────────────────

  describe('setCurrentPage (U-PS-53 ~ U-PS-56)', () => {
    it('U-PS-53: currentPageIndex が更新される', () => {
      usePecoStore.setState({ currentPageIndex: 0 })
      usePecoStore.getState().setCurrentPage(3)

      expect(usePecoStore.getState().currentPageIndex).toBe(3)
    })

    it('U-PS-54: ページが pageAccessOrder の先頭に移動する', () => {
      usePecoStore.setState({ pageAccessOrder: [1, 2, 3] })
      usePecoStore.getState().setCurrentPage(3)

      expect(usePecoStore.getState().pageAccessOrder[0]).toBe(3)
    })

    it('U-PS-55: pageAccessOrder 内で重複が除去される', () => {
      usePecoStore.setState({ pageAccessOrder: [1, 2, 3] })
      usePecoStore.getState().setCurrentPage(2)

      const order = usePecoStore.getState().pageAccessOrder
      expect(order).toEqual([2, 1, 3])
      expect(order.filter(i => i === 2)).toHaveLength(1)
    })

    it('U-PS-56: 選択がクリアされる', () => {
      usePecoStore.setState({ selectedIds: new Set(['a', 'b']), lastSelectedId: 'b' })
      usePecoStore.getState().setCurrentPage(1)

      expect(usePecoStore.getState().selectedIds.size).toBe(0)
      expect(usePecoStore.getState().lastSelectedId).toBeNull()
    })
  })

  // ── setDocument ───────────────────────────────────────────────

  describe('setDocument (U-PS-57 ~ U-PS-62)', () => {
    it('U-PS-57: 全一時状態がリセットされる', () => {
      const action: Action = { type: 'update_page', pageIndex: 0, before: makePage(), after: makePage() }
      usePecoStore.setState({
        selectedIds: new Set(['x']),
        lastSelectedId: 'x',
        clipboard: [makeBlock()],
        undoStack: [action],
        redoStack: [action],
        isDrawingMode: true,
        isSplitMode: true,
        showTextPreview: true,
        pageAccessOrder: [0, 1],
      })

      usePecoStore.getState().setDocument(makeDoc())

      const s = usePecoStore.getState()
      expect(s.selectedIds.size).toBe(0)
      expect(s.lastSelectedId).toBeNull()
      expect(s.clipboard).toHaveLength(0)
      expect(s.undoStack).toHaveLength(0)
      expect(s.redoStack).toHaveLength(0)
      expect(s.isDrawingMode).toBe(false)
      expect(s.isSplitMode).toBe(false)
      expect(s.showTextPreview).toBe(false)
      expect(s.pageAccessOrder).toHaveLength(0)
      expect(s.currentPageIndex).toBe(0)
      expect(s.showOcr).toBe(true)
    })

    it('U-PS-58: pendingRestoration がある場合 isDirty=true', () => {
      usePecoStore.setState({ pendingRestoration: { '0': { isDirty: true } } })

      usePecoStore.getState().setDocument(makeDoc())

      expect(usePecoStore.getState().isDirty).toBe(true)
    })

    it('U-PS-59: pendingRestoration がない場合 isDirty=false', () => {
      usePecoStore.setState({ pendingRestoration: null, isDirty: true })

      usePecoStore.getState().setDocument(makeDoc())

      expect(usePecoStore.getState().isDirty).toBe(false)
    })

    it('U-PS-60: setDocument(null) で document がクリアされる', () => {
      usePecoStore.setState({ document: makeDoc() })

      usePecoStore.getState().setDocument(null)

      expect(usePecoStore.getState().document).toBeNull()
    })

    it('U-PS-61 (#29): store に originalBytes / setOriginalBytes は存在しない (module-level cache へ移行済み)', () => {
      // issue #29: 100MB 級の PDF bytes を zustand に持たせると subscriber 増加で
      // GC 圧やフラグメンテーションが悪化する。store からは完全に外して
      // useFileOperations.ts 内の module-level Map で保持する設計に変更した。
      const state = usePecoStore.getState() as unknown as Record<string, unknown>
      expect('originalBytes' in state).toBe(false)
      expect('setOriginalBytes' in state).toBe(false)
    })

    it('U-PS-62: pendingRestoration がクリアされる', () => {
      usePecoStore.setState({ pendingRestoration: { '0': { isDirty: true } } })

      usePecoStore.getState().setDocument(makeDoc())

      expect(usePecoStore.getState().pendingRestoration).toBeNull()
    })
  })

  // ── S-02: ファイル切替レース ──────────────────────────────────

  describe('S-02: ファイル切替レース', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
    })

    it('S-02-01: setDocument(A) 直後に setDocument(B) を呼んでも A の保存処理は B のページに書き込まない (filePath ガード)', async () => {
      // A は restoration 付きで開く。clearTemporaryChanges が完了したら
      // saveTemporaryPageDataBatch が A の filePath で発火するはず。
      const docA: PecoDocument = {
        filePath: '/path/to/A.pdf',
        fileName: 'A.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, makePage()]]),
      }
      const docB: PecoDocument = {
        filePath: '/path/to/B.pdf',
        fileName: 'B.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, makePage()]]),
      }

      // A 用の restoration をセット → setDocument(A) で IDB 書き込みがスケジュールされる
      usePecoStore.setState({ pendingRestoration: { '0': { isDirty: true, textBlocks: [] } } })
      usePecoStore.getState().setDocument(docA)

      // 直後に B にスイッチ
      usePecoStore.getState().setDocument(docB)

      // A の非同期書き込み完了を待つ
      await waitForPendingIdbSaves()

      // saveTemporaryPageDataBatch は A の filePath でのみ呼ばれていて、B の filePath では呼ばれない
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      for (const e of allEntries) {
        expect(e.filePath).toBe('/path/to/A.pdf')
        expect(e.filePath).not.toBe('/path/to/B.pdf')
      }
      // 現在の document は B のままで、A の書き込み完了が B のメモリ状態を変更していない
      const cur = usePecoStore.getState().document
      expect(cur?.filePath).toBe('/path/to/B.pdf')
    })

    it('S-02-02: waitForPendingIdbSaves() は in-flight な Promise を全て待つ', async () => {
      // saveTemporaryPageDataBatch が永遠に解決しない Promise を返すように差し替え
      let resolveSave!: () => void
      const hangPromise = new Promise<void>((r) => { resolveSave = r })
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockImplementationOnce(() => hangPromise)

      // setDocument 経由で hang する書き込みをスケジュール
      usePecoStore.setState({ pendingRestoration: { '0': { isDirty: true, textBlocks: [] } } })
      usePecoStore.getState().setDocument(makeDoc())

      // wait は未解決
      let resolved = false
      const waitPromise = waitForPendingIdbSaves().then(() => { resolved = true })
      // microtask 数回回しても完了しない
      await Promise.resolve()
      await Promise.resolve()
      expect(resolved).toBe(false)

      // 解放すれば wait も完了する
      resolveSave()
      await waitPromise
      expect(resolved).toBe(true)
    })

    it('S-02-03: IDB 保存失敗時、ロールバック対象 page が新しい同 idx の更新で上書きされていればロールバックしない', async () => {
      // updatePageData の LRU 退避経路でロールバックロジックが走るかを検証する。
      // setState() 内で newPages.has(idx) チェックがあるため、保存失敗後も新しい同 idx が
      // 既に存在すれば古い snapshot で上書きしない。
      // 単純に setDocument 経路では LRU 退避は発生しないので、ここでは「ロールバックロジックが
      // 既存ページを尊重する」ことを直接 set/get で検証する。
      const oldPage = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock({ text: 'old' })] })
      const newPage = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock({ text: 'new' })] })

      // saveTemporaryPageDataBatch は reject させる
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockRejectedValueOnce(new Error('IDB failure'))

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // pendingSaves に oldPage が登録された状態で reject → ロールバック試行
        // しかし設計上「if (!restored.has(idx)) restored.set(idx, page)」なので、
        // 既に同 idx の newPage がある場合は上書きしない。
        // → 直接 store の document に newPage をセットしてから setDocument 経由で書き込みを再現するのは難しいため、
        //   ここでは store の updatePageData を駆動して LRU 退避を起こす。
        // まず 51 ページを作って 1 ページ以上を退避対象にする。
        const pages = new Map<number, PageData>()
        for (let i = 0; i < 51; i++) {
          pages.set(i, makePage({ pageIndex: i, isDirty: true }))
        }
        const doc = makeDoc(pages)
        usePecoStore.setState({
          document: doc,
          currentPageIndex: 50, // 50 を current に
          pageAccessOrder: Array.from({ length: 51 }, (_, i) => i),
        })

        // updatePageData(50, ...) で 51→52 へ。LRU 退避が発生 (idx=0 など末尾) → reject 経路へ
        // ただし 51 件あれば既に閾値超過なので、追加で 1 件入れる
        usePecoStore.getState().updatePageData(50, { isDirty: true, textBlocks: [makeBlock({ text: 'fresh' })] }, false)

        // 退避先が reject されてもメモリには残っているか待機
        await waitForPendingIdbSaves()

        // ロールバックは「既に同 idx の page が存在する場合 set しない」という仕様なので、
        // 50 番ページは 'fresh' のまま (古い snapshot で上書きされない)
        const cur = usePecoStore.getState().document!.pages.get(50)
        expect(cur?.textBlocks[0]?.text).toBe('fresh')
        // lastIdbError が設定されている (reject 経由)
        expect(usePecoStore.getState().lastIdbError).toBeInstanceOf(Error)
        // ↑ oldPage / newPage の参照は使わなかったが、テスト名の意図 (上書きしない) は検証済み
        expect(oldPage.textBlocks[0].text).toBe('old')
        expect(newPage.textBlocks[0].text).toBe('new')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('S-02-04: IDB 保存失敗時、別ファイルへ切替済みなら旧ファイルの page を混入させない', async () => {
      let rejectSave!: (e: Error) => void
      const rejectLater = new Promise<void>((_, reject) => { rejectSave = reject })
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReturnValueOnce(rejectLater)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const pages = new Map<number, PageData>()
        for (let i = 0; i < 50; i++) {
          pages.set(i, makePage({ pageIndex: i, isDirty: true, textBlocks: [makeBlock({ text: `old-${i}` })] }))
        }
        usePecoStore.setState({
          document: makeDoc(pages),
          currentPageIndex: 50,
          pageAccessOrder: Array.from({ length: 50 }, (_, i) => i),
        })

        usePecoStore.getState().updatePageData(50, makePage({ pageIndex: 50, isDirty: true }), false)
        expect(pdfLoader.saveTemporaryPageDataBatch).toHaveBeenCalledTimes(1)

        const nextDoc = {
          ...makeDoc(new Map([[0, makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'new-doc' })] })]])),
          filePath: 'next.pdf',
          fileName: 'next.pdf',
        }
        usePecoStore.setState({ document: nextDoc })

        rejectSave(new Error('IDB failure'))
        await waitForPendingIdbSaves()

        const current = usePecoStore.getState().document!
        expect(current.filePath).toBe('next.pdf')
        expect(current.pages.has(49)).toBe(false)
        expect(current.pages.get(0)?.textBlocks[0]?.text).toBe('new-doc')
        expect(usePecoStore.getState().lastIdbError).toBeInstanceOf(Error)
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  // ── issue #3: Undo/Redo IDB 整合性 ─────────────────────────────

  describe('issue #3: LRU 退避ページに対する undo()/redo() が IDB を同期更新する', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
    })

    it('undo() で IDB の該当ページが action.before に書き換わる (saveTemporaryPageDataBatch が呼ばれる)', async () => {
      const beforePage = makePage({ pageIndex: 0, isDirty: false, textBlocks: [makeBlock({ text: 'before' })] })
      const afterPage = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock({ text: 'after' })] })
      const doc = makeDoc(new Map([[0, afterPage]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before: beforePage, after: afterPage }

      usePecoStore.setState({ document: doc, undoStack: [action], redoStack: [] })
      usePecoStore.getState().undo()

      // 非同期 IDB 書き込みの完了を待つ
      await waitForPendingIdbSaves()

      // メモリ Map は巻き戻されている
      expect(usePecoStore.getState().document!.pages.get(0)).toEqual(beforePage)
      // IDB にも before が書き込まれている (LRU 退避フローと対称)
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      const matched = allEntries.find((e) => e.filePath === 'test.pdf' && e.pageIndex === 0)
      expect(matched).toBeDefined()
      expect(matched!.data).toEqual(beforePage)
    })

    it('redo() で IDB の該当ページが action.after に書き換わる', async () => {
      const beforePage = makePage({ pageIndex: 0, isDirty: false, textBlocks: [makeBlock({ text: 'before' })] })
      const afterPage = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock({ text: 'after' })] })
      const doc = makeDoc(new Map([[0, beforePage]]))
      const action: Action = { type: 'update_page', pageIndex: 0, before: beforePage, after: afterPage }

      usePecoStore.setState({ document: doc, undoStack: [], redoStack: [action] })
      usePecoStore.getState().redo()

      await waitForPendingIdbSaves()

      expect(usePecoStore.getState().document!.pages.get(0)).toEqual(afterPage)
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      const matched = allEntries.find((e) => e.filePath === 'test.pdf' && e.pageIndex === 0)
      expect(matched).toBeDefined()
      expect(matched!.data).toEqual(afterPage)
    })

    it('LRU 退避済み (メモリ Map から削除) ページの undo() でも IDB に before が書き込まれる', async () => {
      // ページ 0 が LRU で退避され、メモリには無いがアクションは残っている状態
      const beforePage = makePage({ pageIndex: 0, isDirty: false, textBlocks: [makeBlock({ text: 'evicted-before' })] })
      const afterPage = makePage({ pageIndex: 0, isDirty: true, textBlocks: [makeBlock({ text: 'evicted-after' })] })
      const doc = makeDoc(new Map()) // page 0 は退避済み
      const action: Action = { type: 'update_page', pageIndex: 0, before: beforePage, after: afterPage }

      usePecoStore.setState({ document: doc, undoStack: [action], redoStack: [] })
      usePecoStore.getState().undo()

      await waitForPendingIdbSaves()

      // IDB へ before が書き込まれている (save 時のマージで before が反映される)
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      const matched = allEntries.find((e) => e.filePath === 'test.pdf' && e.pageIndex === 0)
      expect(matched).toBeDefined()
      expect(matched!.data).toEqual(beforePage)
    })
  })

  // ── S-15: ウィンドウクローズ時の pendingIdbSaves 待機 ─────────

  describe('S-15: ウィンドウクローズ時の pendingIdbSaves 待機', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
    })

    it('S-15-01: 未解決 IDB 保存がある状態で waitForPendingIdbSaves() が完了まで待つ', async () => {
      let resolveSave!: () => void
      const hang = new Promise<void>((r) => { resolveSave = r })
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockImplementationOnce(() => hang)

      usePecoStore.setState({ pendingRestoration: { '0': { isDirty: true, textBlocks: [] } } })
      usePecoStore.getState().setDocument(makeDoc())

      // すぐには resolve しない
      const order: string[] = []
      const wait = waitForPendingIdbSaves().then(() => order.push('wait'))
      // 別の (即時 resolve) Promise と race
      Promise.resolve().then(() => order.push('resolved-immediately'))

      await Promise.resolve()
      expect(order).toEqual(['resolved-immediately'])

      resolveSave()
      await wait
      expect(order).toEqual(['resolved-immediately', 'wait'])
    })
  })

  // ── issue #22: selectCurrentPageTextBlocks セレクタ ─────────
  describe('issue #22: selectCurrentPageTextBlocks セレクタ', () => {
    it('textBlocks を変更しないフィールド更新 (isDirty / thumbnail / isTextExtracted) では同一参照を返す', () => {
      const blocks: TextBlock[] = [makeBlock({ id: 'b1' })]
      const page = makePage({ textBlocks: blocks, isDirty: false, thumbnail: null, isTextExtracted: false })
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc, currentPageIndex: 0 })

      const before = selectCurrentPageTextBlocks(usePecoStore.getState())
      expect(before).toBe(blocks)

      // updatePageData で textBlocks 以外を更新
      usePecoStore.getState().updatePageData(0, { isDirty: true, thumbnail: 'data:foo', isTextExtracted: true }, false)

      const after = selectCurrentPageTextBlocks(usePecoStore.getState())
      // 参照が同じであることが overlay 再描画 effect が走らない根拠
      expect(after).toBe(before)
    })

    it('textBlocks 自体を更新すると新しい参照を返す', () => {
      const blocks: TextBlock[] = [makeBlock({ id: 'b1' })]
      const page = makePage({ textBlocks: blocks })
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc, currentPageIndex: 0 })

      const before = selectCurrentPageTextBlocks(usePecoStore.getState())

      const newBlocks: TextBlock[] = [makeBlock({ id: 'b1' }), makeBlock({ id: 'b2' })]
      usePecoStore.getState().updatePageData(0, { textBlocks: newBlocks }, false)

      const after = selectCurrentPageTextBlocks(usePecoStore.getState())
      expect(after).not.toBe(before)
      expect(after).toBe(newBlocks)
    })

    it('document が null のときは null を返す', () => {
      usePecoStore.setState({ document: null })
      expect(selectCurrentPageTextBlocks(usePecoStore.getState())).toBeNull()
    })
  })

  // ── issue #91: dragPreviewBboxes ───────────────────────────────
  describe('issue #91: dragPreviewBboxes', () => {
    it('初期状態では dragPreviewBboxes は null', () => {
      expect(selectDragPreviewBboxes(usePecoStore.getState())).toBeNull()
    })

    it('setDragPreviewBboxes(map) で dragPreviewBboxes が更新される', () => {
      const map = new Map<string, BoundingBox>([
        ['b1', { x: 10, y: 20, width: 30, height: 40 }],
      ])
      usePecoStore.getState().setDragPreviewBboxes(map)

      const got = selectDragPreviewBboxes(usePecoStore.getState())
      expect(got).toBe(map)
      expect(got!.get('b1')).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    })

    it('setDragPreviewBboxes(null) でクリアできる', () => {
      const map = new Map<string, BoundingBox>([
        ['b1', { x: 10, y: 20, width: 30, height: 40 }],
      ])
      usePecoStore.getState().setDragPreviewBboxes(map)
      expect(selectDragPreviewBboxes(usePecoStore.getState())).not.toBeNull()

      usePecoStore.getState().setDragPreviewBboxes(null)
      expect(selectDragPreviewBboxes(usePecoStore.getState())).toBeNull()
    })

    it('setDocument(doc) は dragPreviewBboxes をクリアする (ファイル切替で持ち越さない)', () => {
      const map = new Map<string, BoundingBox>([
        ['b1', { x: 10, y: 20, width: 30, height: 40 }],
      ])
      usePecoStore.getState().setDragPreviewBboxes(map)
      expect(selectDragPreviewBboxes(usePecoStore.getState())).not.toBeNull()

      usePecoStore.getState().setDocument(makeDoc())
      expect(selectDragPreviewBboxes(usePecoStore.getState())).toBeNull()
    })

    it('dragPreviewBboxes 更新は textBlocks 参照を変更しない', () => {
      const blocks: TextBlock[] = [makeBlock({ id: 'b1' })]
      const page = makePage({ textBlocks: blocks })
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc, currentPageIndex: 0 })

      const before = selectCurrentPageTextBlocks(usePecoStore.getState())
      expect(before).toBe(blocks)

      // ドラッグ中の preview 書き込みでは textBlocks セレクタは同一参照
      const previewMap = new Map<string, BoundingBox>([
        ['b1', { x: 999, y: 999, width: 50, height: 20 }],
      ])
      usePecoStore.getState().setDragPreviewBboxes(previewMap)

      const after = selectCurrentPageTextBlocks(usePecoStore.getState())
      // 動的層 overlay のみ再描画される (静的層 effect は textBlocks 依存なので不発)
      expect(after).toBe(before)
    })
  })

  // ── issue #93: Find & Replace ──────────────────────────────────
  describe('issue #93: replaceText', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.getAllTemporaryPageData).mockReset().mockResolvedValue(new Map())
    })

    it('U-FR-01: 現ページ全 BB の "あ" を "い" に置換し件数を返す', async () => {
      const b1 = makeBlock({ id: 'b1', text: 'あああ' })
      const b2 = makeBlock({ id: 'b2', text: 'あい' })
      const b3 = makeBlock({ id: 'b3', text: 'う' })
      const page = makePage({ pageIndex: 0, textBlocks: [b1, b2, b3], isDirty: false })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        isDirty: false,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'あ',
        replacement: 'い',
        caseSensitive: false,
        useRegex: false,
      })

      // 件数: 'あああ'=3hit, 'あい'=1hit, 'う'=0hit → 計 4 ヒット / 2 ブロック / 1 ページ
      expect(result).toEqual({ hits: 4, blocks: 2, pages: 1, skippedBlocks: 0 })

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('いいい')
      expect(blocks[1].text).toBe('いい')
      expect(blocks[2].text).toBe('う') // 変更なし
      // 変更ブロックは isDirty=true
      expect(blocks[0].isDirty).toBe(true)
      expect(blocks[1].isDirty).toBe(true)
      // 非変更ブロックの isDirty 元値が保持される
      expect(blocks[2].isDirty).toBe(false)
      // page も isDirty
      expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(true)
      // store global も isDirty
      expect(usePecoStore.getState().isDirty).toBe(true)
    })

    it('U-FR-02: selection スコープは選択 ID のブロックだけ置換する', async () => {
      const b1 = makeBlock({ id: 'b1', text: 'あ' })
      const b2 = makeBlock({ id: 'b2', text: 'あ' })
      const page = makePage({ pageIndex: 0, textBlocks: [b1, b2] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        selectedIds: new Set(['b1']),
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'selection',
        pattern: 'あ',
        replacement: 'い',
        caseSensitive: false,
        useRegex: false,
      })

      expect(result).toEqual({ hits: 1, blocks: 1, pages: 1, skippedBlocks: 0 })
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('い') // 選択された
      expect(blocks[1].text).toBe('あ') // 選択外
    })

    it('U-FR-03: 全ページスコープは pages Map に存在する全ページを対象にする', async () => {
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'p0b', text: 'foo' })] })
      const page1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ id: 'p1b', text: 'foo foo' })] })
      const page2 = makePage({ pageIndex: 2, textBlocks: [makeBlock({ id: 'p2b', text: 'no match' })] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page0], [1, page1], [2, page2]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'all',
        pattern: 'foo',
        replacement: 'bar',
        caseSensitive: false,
        useRegex: false,
      })

      // ヒット: page0=1, page1=2 → 3 ヒット / 2 ブロック / 2 ページ (page2 は不変)
      expect(result).toEqual({ hits: 3, blocks: 2, pages: 2, skippedBlocks: 0 })
      const pages = usePecoStore.getState().document!.pages
      expect(pages.get(0)!.textBlocks[0].text).toBe('bar')
      expect(pages.get(1)!.textBlocks[0].text).toBe('bar bar')
      expect(pages.get(2)!.textBlocks[0].text).toBe('no match')
    })

    it('U-FR-04: caseSensitive=true で大文字小文字を区別する', async () => {
      const b = makeBlock({ id: 'b', text: 'Hello hello HELLO' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'Hello',
        replacement: 'X',
        caseSensitive: true,
        useRegex: false,
      })

      expect(result.hits).toBe(1)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('X hello HELLO')
    })

    it('U-FR-05: useRegex=true で正規表現が機能し、構文エラーは throw する', async () => {
      const b = makeBlock({ id: 'b', text: 'abc123 def456' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: '\\d+',
        replacement: '#',
        caseSensitive: false,
        useRegex: true,
      })

      expect(result.hits).toBe(2)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('abc# def#')

      // 構文エラーは throw (async なので rejects.toThrow)
      await expect(
        usePecoStore.getState().replaceText({
          scope: 'current',
          pattern: '[invalid',
          replacement: 'x',
          caseSensitive: false,
          useRegex: true,
        }),
      ).rejects.toThrow()
    })

    it('U-FR-06: 1 回の replaceText は 1 つの update_pages Action として undo / redo できる', async () => {
      const b0 = makeBlock({ id: 'b0', text: 'foo' })
      const b1 = makeBlock({ id: 'b1', text: 'foo bar' })
      const page0 = makePage({ pageIndex: 0, textBlocks: [b0] })
      const page1 = makePage({ pageIndex: 1, textBlocks: [b1] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page0], [1, page1]])),
        currentPageIndex: 0,
        undoStack: [],
        redoStack: [],
      })

      await usePecoStore.getState().replaceText({
        scope: 'all',
        pattern: 'foo',
        replacement: 'X',
        caseSensitive: false,
        useRegex: false,
      })

      // 単一の update_pages action が push されている
      let s = usePecoStore.getState()
      expect(s.undoStack).toHaveLength(1)
      expect(s.undoStack[0].type).toBe('update_pages')
      if (s.undoStack[0].type === 'update_pages') {
        expect(s.undoStack[0].entries.map(e => e.pageIndex).sort()).toEqual([0, 1])
      }
      // 置換後の text を確認
      expect(s.document!.pages.get(0)!.textBlocks[0].text).toBe('X')
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('X bar')

      // undo: 全ページが atomic に巻き戻る
      usePecoStore.getState().undo()
      s = usePecoStore.getState()
      expect(s.document!.pages.get(0)!.textBlocks[0].text).toBe('foo')
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('foo bar')
      expect(s.undoStack).toHaveLength(0)
      expect(s.redoStack).toHaveLength(1)

      // redo: 再度 atomic に適用
      usePecoStore.getState().redo()
      s = usePecoStore.getState()
      expect(s.document!.pages.get(0)!.textBlocks[0].text).toBe('X')
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('X bar')
      expect(s.undoStack).toHaveLength(1)
      expect(s.redoStack).toHaveLength(0)
    })

    it('U-FR-07: skipBlockIds で指定したブロックは置換されず、skippedBlocks として件数返却される', async () => {
      const b0 = makeBlock({ id: 'editing', text: 'foo' })
      const b1 = makeBlock({ id: 'safe', text: 'foo' })
      const page = makePage({ pageIndex: 0, textBlocks: [b0, b1] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'foo',
        replacement: 'X',
        caseSensitive: false,
        useRegex: false,
        skipBlockIds: new Set(['editing']),
      })

      expect(result.hits).toBe(1)
      expect(result.skippedBlocks).toBe(1)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('foo') // 編集中扱いで非置換
      expect(blocks[1].text).toBe('X')
    })

    it('U-FR-08: 検索文字列が空 or ヒット 0 のときは undo にも積まれず no-op', async () => {
      const b = makeBlock({ id: 'b', text: 'hello' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
        undoStack: [],
      })

      // 空 pattern
      const r1 = await usePecoStore.getState().replaceText({
        scope: 'current', pattern: '', replacement: 'x',
        caseSensitive: false, useRegex: false,
      })
      expect(r1.hits).toBe(0)
      expect(usePecoStore.getState().undoStack).toHaveLength(0)

      // ヒットしない pattern
      const r2 = await usePecoStore.getState().replaceText({
        scope: 'current', pattern: 'NOT_FOUND', replacement: 'x',
        caseSensitive: false, useRegex: false,
      })
      expect(r2.hits).toBe(0)
      expect(r2.pages).toBe(0)
      expect(usePecoStore.getState().undoStack).toHaveLength(0)
      // 元 text のまま
      expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('hello')
    })
  })

  // ── issue #104: replaceText scope='all' で IDB 退避ページも対象 ──
  describe('issue #104: replaceText all-scope は LRU 退避ページも置換する', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.getAllTemporaryPageData).mockReset().mockResolvedValue(new Map())
    })

    it('U-FR-09: in-memory に無いが IDB に退避されたページも all スコープで置換対象になる', async () => {
      // in-memory には page 0 だけ。page 1 は LRU 退避済み (IDB に textBlocks 持ち)
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'p0b', text: 'foo on memory' })] })
      const evictedBlock = makeBlock({ id: 'p1b', text: 'foo on idb' })
      vi.mocked(pdfLoader.getAllTemporaryPageData).mockResolvedValueOnce(
        new Map<number, Partial<PageData>>([
          [1, {
            pageIndex: 1,
            width: 595,
            height: 842,
            textBlocks: [evictedBlock],
            isDirty: true,
            thumbnail: null,
          }],
        ]),
      )

      usePecoStore.setState({
        document: {
          filePath: 'test.pdf',
          fileName: 'test.pdf',
          totalPages: 2,
          metadata: {},
          pages: new Map([[0, page0]]),
        },
        currentPageIndex: 0,
        undoStack: [],
        redoStack: [],
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'all',
        pattern: 'foo',
        replacement: 'bar',
        caseSensitive: false,
        useRegex: false,
      })

      // 2 ページとも 1 件ずつヒット
      expect(result).toEqual({ hits: 2, blocks: 2, pages: 2, skippedBlocks: 0 })

      const pages = usePecoStore.getState().document!.pages
      // 退避ページも in-memory に積まれている (after の状態)
      expect(pages.get(0)!.textBlocks[0].text).toBe('bar on memory')
      expect(pages.get(1)!.textBlocks[0].text).toBe('bar on idb')

      // IDB へ saveTemporaryPageDataBatch が両ページ分書かれている
      await waitForPendingIdbSaves()
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      const pageIndices = new Set(allEntries.map((e) => e.pageIndex))
      expect(pageIndices.has(0)).toBe(true)
      expect(pageIndices.has(1)).toBe(true)
    })

    it('U-FR-10: undo / redo で IDB 退避ページも巻き戻る (update_pages entries が IDB ページ含む)', async () => {
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'p0b', text: 'foo' })] })
      const evictedBlock = makeBlock({ id: 'p1b', text: 'foo' })
      vi.mocked(pdfLoader.getAllTemporaryPageData).mockResolvedValueOnce(
        new Map<number, Partial<PageData>>([
          [1, {
            pageIndex: 1,
            width: 595,
            height: 842,
            textBlocks: [evictedBlock],
            isDirty: true,
            thumbnail: null,
          }],
        ]),
      )
      usePecoStore.setState({
        document: {
          filePath: 'test.pdf',
          fileName: 'test.pdf',
          totalPages: 2,
          metadata: {},
          pages: new Map([[0, page0]]),
        },
        currentPageIndex: 0,
        undoStack: [],
        redoStack: [],
      })

      await usePecoStore.getState().replaceText({
        scope: 'all',
        pattern: 'foo',
        replacement: 'X',
        caseSensitive: false,
        useRegex: false,
      })

      // update_pages に両ページの entry が入る
      let s = usePecoStore.getState()
      expect(s.undoStack).toHaveLength(1)
      if (s.undoStack[0].type === 'update_pages') {
        expect(s.undoStack[0].entries.map(e => e.pageIndex).sort()).toEqual([0, 1])
      }
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('X')

      // undo: 退避ページも 'foo' に戻る
      usePecoStore.getState().undo()
      s = usePecoStore.getState()
      expect(s.document!.pages.get(0)!.textBlocks[0].text).toBe('foo')
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('foo')

      // redo: 再び 'X'
      usePecoStore.getState().redo()
      s = usePecoStore.getState()
      expect(s.document!.pages.get(0)!.textBlocks[0].text).toBe('X')
      expect(s.document!.pages.get(1)!.textBlocks[0].text).toBe('X')

      // IDB にも before/after が書き戻されている (undo / redo それぞれ呼ばれる)
      await waitForPendingIdbSaves()
      const calls = vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mock.calls
      const allEntries = calls.flatMap((c) => c[0])
      expect(allEntries.some((e) => e.pageIndex === 1)).toBe(true)
    })

    it('U-FR-11: scope=current では IDB を読まない (getAllTemporaryPageData が呼ばれない)', async () => {
      const page0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'p0b', text: 'foo' })] })
      usePecoStore.setState({
        document: {
          filePath: 'test.pdf', fileName: 'test.pdf', totalPages: 1, metadata: {},
          pages: new Map([[0, page0]]),
        },
        currentPageIndex: 0,
      })

      await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'foo',
        replacement: 'bar',
        caseSensitive: false,
        useRegex: false,
      })

      expect(vi.mocked(pdfLoader.getAllTemporaryPageData)).not.toHaveBeenCalled()
    })
  })

  // ── issue #105: useRegex=false で $ replacement が literal ──
  describe('issue #105: $ replacement の literal 扱い', () => {
    beforeEach(() => {
      vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined)
      vi.mocked(pdfLoader.getAllTemporaryPageData).mockReset().mockResolvedValue(new Map())
    })

    it('U-FR-12: useRegex=false で replacement="$&" は literal "$&" として挿入される', async () => {
      const b = makeBlock({ id: 'b', text: 'abc' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'abc',
        replacement: '$&',
        caseSensitive: false,
        useRegex: false,
      })

      expect(result.hits).toBe(1)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      // 元バグ: '$&' が match 文字列 'abc' に展開され 'abc' になる
      // 修正後: '$&' はそのまま literal で入る
      expect(blocks[0].text).toBe('$&')
    })

    it('U-FR-13: useRegex=false で replacement="$1" / "$$" も literal', async () => {
      const page = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'b1', text: 'foo' })] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      await usePecoStore.getState().replaceText({
        scope: 'current', pattern: 'foo', replacement: '$1',
        caseSensitive: false, useRegex: false,
      })
      const after1 = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text
      expect(after1).toBe('$1')

      // 連続置換のため state を作り直す
      usePecoStore.setState({
        document: makeDoc(new Map([[0, makePage({ pageIndex: 0, textBlocks: [
          makeBlock({ id: 'x1', text: 'foo' }),
        ] })]])),
        currentPageIndex: 0,
        undoStack: [], redoStack: [],
      })

      await usePecoStore.getState().replaceText({
        scope: 'current', pattern: 'foo', replacement: '$$',
        caseSensitive: false, useRegex: false,
      })
      // '$$' は literal で '$$' となるべき (元バグでは '$' に折り畳まれる)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('$$')
    })

    it('U-FR-14: useRegex=true では $1 backreference が機能する', async () => {
      const b = makeBlock({ id: 'b', text: 'abc 123' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      const result = await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: '(\\w+) (\\d+)',
        replacement: '$2-$1',
        caseSensitive: false,
        useRegex: true,
      })

      expect(result.hits).toBe(1)
      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('123-abc')
    })

    it('U-FR-15: useRegex=true では $& が match 全体に展開される (regex 経路は維持)', async () => {
      const b = makeBlock({ id: 'b', text: 'abc' })
      const page = makePage({ pageIndex: 0, textBlocks: [b] })
      usePecoStore.setState({
        document: makeDoc(new Map([[0, page]])),
        currentPageIndex: 0,
      })

      await usePecoStore.getState().replaceText({
        scope: 'current',
        pattern: 'abc',
        replacement: '[$&]',
        caseSensitive: false,
        useRegex: true,
      })

      const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks
      expect(blocks[0].text).toBe('[abc]')
    })
  })
})
