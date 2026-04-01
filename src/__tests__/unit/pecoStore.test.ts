import { describe, it, expect, beforeEach } from 'vitest'
import { usePecoStore } from '../../store/pecoStore'
import type { PecoDocument, PageData, Action } from '../../types'

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

function makeDoc(pages: Map<number, PageData> = new Map([[0, makePage()]])): PecoDocument {
  return {
    filePath: '',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

const INITIAL_STATE = {
  document:         null,
  originalBytes:    null,
  thumbnails:       new Map(),
  currentPageIndex: 0,
  zoom:             100,
  isDirty:          false,
  showOcr:          true,
  showTextPreview:  false,
  isDrawingMode:    false,
  isSplitMode:      false,
  selectedIds:      new Set<string>(),
  undoStack:        [] as Action[],
  redoStack:        [] as Action[],
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

})
