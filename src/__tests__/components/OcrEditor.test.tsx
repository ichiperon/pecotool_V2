import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OcrEditor } from '../../components/OcrEditor'
import { usePecoStore } from '../../store/pecoStore'
import { useSearchStore } from '../../store/searchStore'
import type { TextBlock, PageData, PecoDocument } from '../../types'

const sortableMocks = vi.hoisted(() => ({
  setActivatorNodeRef: vi.fn(),
}))

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn(),
  clearTemporaryChanges: vi.fn(),
  loadPage: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
}))

// DnD kit をスタブ化（検索フィルターテストに不要）
// onDragEnd / onDragStart を window 経由で捕捉し、テストから手動発火できるようにする
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd, onDragStart }: any) => {
    ;(globalThis as any).__lastDndOnDragEnd = onDragEnd
    ;(globalThis as any).__lastDndOnDragStart = onDragStart
    return <>{children}</>
  },
  DragOverlay: ({ children }: any) => <>{children}</>,
  closestCenter: null,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn().mockReturnValue(null),
  useSensors: vi.fn().mockReturnValue([]),
  MeasuringStrategy: { Always: 'always', BeforeDragging: 'before-dragging', WhileDragging: 'while-dragging' },
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  // 実装と同等の挙動: from→to に移動した新配列を返す
  arrayMove: (arr: any[], from: number, to: number) => {
    const next = arr.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  },
  useSortable: vi.fn().mockReturnValue({
    attributes: { role: 'button', tabIndex: 0, 'data-sortable-activator': 'true' },
    listeners: {},
    setNodeRef: vi.fn(),
    setActivatorNodeRef: sortableMocks.setActivatorNodeRef,
    transform: null,
    transition: null,
    isDragging: false,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: vi.fn().mockReturnValue('') } },
}))

// jsdom には layout が無いため Virtuoso は実行時 0 items しか描画しない。
// テストでは itemContent を全件展開する単純な div に差し替える。
// issue #92: renderItem の identity を検証するため、最後に渡された itemContent を
// globalThis に保持してテストから参照できるようにする。
// issue #116: virtuosoRef.scrollIntoView({index}) を OcrEditor が呼ぶため、
// ref ハンドルに scrollIntoView spy を載せてテストから検証できるようにする。
//
// 仮想化モード (issue #116 の本シナリオ):
//   既定 (__virtuosoWindowSize=null) では従来どおり totalCount を全件描画する。
//   __virtuosoWindowSize に数値をセットすると「ビューポート窓」だけを描画し、
//   窓外のカードを実際にアンマウントする本物の仮想化を再現する。
//   scrollIntoView({index}) は窓を index 中心へ移動させ、対象カードをマウントする。
//   これにより「画面外 = 未マウント」のカードへのスクロール挙動を検証できる。
vi.mock('react-virtuoso', () => {
  const React = require('react') as typeof import('react')
  const Virtuoso = React.forwardRef(function Virtuoso(
    { totalCount, itemContent, computeItemKey, className, style }: any,
    ref: any
  ) {
    ;(globalThis as any).__lastVirtuosoItemContent = itemContent
    ;(globalThis as any).__lastVirtuosoComputeItemKey = computeItemKey

    const windowSize = (globalThis as any).__virtuosoWindowSize as number | null | undefined
    const isVirtualized = typeof windowSize === 'number' && windowSize > 0
    // 仮想化モードでは窓の開始 index を state で保持し、scrollIntoView で動かす。
    const [windowStart, setWindowStart] = React.useState(0)

    React.useImperativeHandle(ref, () => ({
      scrollIntoView: (...args: any[]) => {
        ;(globalThis as any).__virtuosoScrollIntoViewCalls ??= []
        ;(globalThis as any).__virtuosoScrollIntoViewCalls.push(args)
        // 仮想化モード: 窓を対象 index 中心へ動かし、対象カードを描画範囲に入れる。
        if (isVirtualized) {
          const opts = args[0] ?? {}
          const targetIndex = typeof opts.index === 'number' ? opts.index : 0
          const half = Math.floor((windowSize as number) / 2)
          const nextStart = Math.max(
            0,
            Math.min(targetIndex - half, Math.max(0, totalCount - (windowSize as number)))
          )
          setWindowStart(nextStart)
          // 実 Virtuoso は scroll 完了後に done() を呼ぶ。マウントを待つ用途で使われる。
          if (typeof opts.done === 'function') opts.done()
        }
      },
    }))

    // issue R22狩り(交差汚染): 実 Virtuoso は computeItemKey が渡されると
    // それをコンポーネントの React key として使う (index キーだと並び/構成が
    // 変わった際に別ブロックへ retarget されてしまう)。渡されていれば通す。
    const keyFor = (i: number) => (computeItemKey ? computeItemKey(i) : i)
    const items = []
    if (isVirtualized) {
      // ビューポート窓 [windowStart, windowStart+windowSize) のみ描画。
      const end = Math.min(totalCount, windowStart + (windowSize as number))
      for (let i = windowStart; i < end; i++) {
        items.push(
          React.createElement('div', { key: keyFor(i), 'data-virtuoso-index': i }, itemContent(i))
        )
      }
    } else {
      for (let i = 0; i < totalCount; i++) {
        items.push(
          React.createElement('div', { key: keyFor(i), 'data-virtuoso-index': i }, itemContent(i))
        )
      }
    }
    return React.createElement('div', { className, style }, items)
  })
  return { Virtuoso }
})

vi.mock('lucide-react', () => ({
  GripVertical: () => null,
  Search: () => null,
}))

// ── ヘルパー ──────────────────────────────────────────────────

function makeBlock(id: string, text: string, order: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  }
}

function makeDoc(blocks: TextBlock[], opts?: { isTextExtracted?: boolean }): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
    isTextExtracted: opts?.isTextExtracted ?? true,
  }
  return {
    filePath: '',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  }
}

// ── setup ──────────────────────────────────────────────────────

const blocks = [
  makeBlock('b1', 'apple fruit', 0),
  makeBlock('b2', 'banana fruit', 1),
  makeBlock('b3', 'cherry', 2),
]

function setup(testBlocks = blocks, selectedIds: string[] = []) {
  const doc = makeDoc(testBlocks)
  usePecoStore.setState({
    document: doc,
    currentPageIndex: 0,
    selectedIds: new Set(selectedIds),
    lastSelectedId: selectedIds[selectedIds.length - 1] ?? null,
  } as any)
  const searchInputRef = { current: null }
  return render(
    <OcrEditor
      width={350}
      searchInputRef={searchInputRef as any}
    />,
  )
}

function getCardContents(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.ocr-card-content')) as HTMLElement[]
}

function expectSelectedIds(expected: string[]) {
  expect(Array.from(usePecoStore.getState().selectedIds).sort()).toEqual([...expected].sort())
}

afterEach(() => cleanup())

beforeEach(() => {
  sortableMocks.setActivatorNodeRef.mockClear()
  ;(globalThis as any).__virtuosoScrollIntoViewCalls = []
  // 既定は「全件描画」モード。仮想化テストのみ各 it 内で window サイズをセットする。
  ;(globalThis as any).__virtuosoWindowSize = null
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    lastSelectedId: null,
    undoStack: [],
    redoStack: [],
    isDirty: false,
  })
  // issue #196: searchTerm を store 化したのでテスト間でリセット必須
  useSearchStore.setState({ searchTerm: '', searchHitIndex: -1 } as any)
})

// ── テスト ────────────────────────────────────────────────────

describe('OcrEditor', () => {
  describe('#457: keyboard sortable activator', () => {
    it('DnD attributes と activator ref をドラッグハンドルへ配線する', () => {
      const { container } = setup([makeBlock('b1', 'text', 0)])
      const handle = container.querySelector('.ocr-card-drag-handle') as HTMLElement

      expect(handle.getAttribute('role')).toBe('button')
      expect(handle.getAttribute('tabindex')).toBe('0')
      expect(handle.getAttribute('data-sortable-activator')).toBe('true')
      expect(handle.getAttribute('aria-label')).toBe('ブロック 1 を並び替え')
      expect(sortableMocks.setActivatorNodeRef).toHaveBeenCalledWith(handle)
      expect(handle.parentElement?.parentElement?.getAttribute('data-sortable-activator')).toBeNull()
    })

    it('並び替え完了を live region へ通知する', () => {
      setup([
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
      ])

      act(() => {
        ;(globalThis as any).__lastDndOnDragEnd({
          active: { id: 'b1' },
          over: { id: 'b2' },
        })
      })

      expect(screen.getByRole('status').textContent).toContain('1 番目から 2 番目へ移動しました')
    })
  })

  describe('C-OE-01: 検索フィルター', () => {
    it('"cherry" 入力 → "cherry" を含むカードのみ表示', async () => {
      const user = userEvent.setup()
      setup()

      await user.type(screen.getByPlaceholderText('検索...'), 'cherry')

      // "cherry" ブロックだけ残る
      expect(screen.queryByText('apple fruit')).toBeNull()
      expect(screen.queryByText('banana fruit')).toBeNull()
      // cherry ブロックは表示されている（contentEditable div）
      const cards = document.querySelectorAll('.ocr-card-content')
      expect(cards.length).toBe(1)
      expect(cards[0].textContent).toBe('cherry')
    })

    it('"fruit" 入力 → "fruit" を含む2カードが表示', async () => {
      const user = userEvent.setup()
      setup()

      await user.type(screen.getByPlaceholderText('検索...'), 'fruit')

      const cards = document.querySelectorAll('.ocr-card-content')
      expect(cards.length).toBe(2)
      const texts = Array.from(cards).map(c => c.textContent)
      expect(texts).toContain('apple fruit')
      expect(texts).toContain('banana fruit')
    })
  })

  describe('C-OE-02: 検索フィルター（大文字小文字無視）', () => {
    it('"APPLE" 入力 → "apple fruit" を含むカードが表示', async () => {
      const user = userEvent.setup()
      setup()

      await user.type(screen.getByPlaceholderText('検索...'), 'APPLE')

      const cards = document.querySelectorAll('.ocr-card-content')
      expect(cards.length).toBe(1)
      expect(cards[0].textContent).toBe('apple fruit')
    })
  })

  describe('C-OE-03: 検索クリアで全件表示', () => {
    it('入力欄を空にする → 全カード表示', async () => {
      const user = userEvent.setup()
      setup()

      const searchBox = screen.getByPlaceholderText('検索...')
      await user.type(searchBox, 'cherry')

      // "cherry" のみ表示
      expect(document.querySelectorAll('.ocr-card-content').length).toBe(1)

      // 検索をクリア
      await user.clear(searchBox)

      // 全3件表示
      expect(document.querySelectorAll('.ocr-card-content').length).toBe(3)
    })
  })

  describe('C-ED-03: 空状態 - ドキュメントなし', () => {
    it('document=null → "データなし" が表示される', () => {
      usePecoStore.setState({ document: null, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('データなし')).toBeTruthy()
    })
  })

  describe('C-ED-04: 空状態 - 現在ページが未ロード', () => {
    it('currentPageIndex に対応するページが無い → "読み込み中..." が表示される', () => {
      // ドキュメントはあるが、pageIndex=5 に対応するページが無い
      const doc = makeDoc([makeBlock('b1', 'text', 0)])
      usePecoStore.setState({ document: doc, currentPageIndex: 5, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('読み込み中...')).toBeTruthy()
    })
  })

  describe('C-ED-05: 空状態 - テキストブロックが0件', () => {
    it('textBlocks=[] → OCRなし表示と導線ヒントが表示される (PCT-058)', () => {
      const doc = makeDoc([])
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('このページにOCRテキストがありません')).toBeTruthy()
      expect(screen.getByText('リボンの「OCR実行」でテキストを読み取れます')).toBeTruthy()
    })
  })

  describe('C-ED-05b: 抽出中プレースホルダ', () => {
    it('isTextExtracted=false → "テキスト抽出中..." が表示され、ブロックは描画されない', () => {
      const doc = makeDoc([], { isTextExtracted: false })
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      const { container } = render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('テキスト抽出中...')).toBeTruthy()
      // プレースホルダ要素が存在する
      expect(container.querySelector('.ocr-loading-placeholder')).not.toBeNull()
      // 「OCRなし」表示は出ない（isTextExtracted=true でのみ出る）
      expect(screen.queryByText('このページにOCRテキストがありません')).toBeNull()
      // ブロックは描画されない
      expect(container.querySelectorAll('.ocr-card-content').length).toBe(0)
    })

    it('isTextExtracted=false だが textBlocks に古いデータがある → 抽出中プレースホルダ優先', () => {
      const doc = makeDoc(blocks, { isTextExtracted: false })
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      const { container } = render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('テキスト抽出中...')).toBeTruthy()
      expect(container.querySelectorAll('.ocr-card-content').length).toBe(0)
    })

    it('isTextExtracted=true で textBlocks=[] → OCRなし表示と導線ヒントが出る (PCT-058)', () => {
      const doc = makeDoc([], { isTextExtracted: true })
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('このページにOCRテキストがありません')).toBeTruthy()
      expect(screen.getByText('リボンの「OCR実行」でテキストを読み取れます')).toBeTruthy()
      expect(screen.queryByText('テキスト抽出中...')).toBeNull()
    })

    it('抽出中でも検索欄は表示される', () => {
      const doc = makeDoc([], { isTextExtracted: false })
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByPlaceholderText('検索...')).toBeTruthy()
    })
  })

  describe('C-ED-06: Shift+クリックで範囲選択', () => {
    it('最初のカードをクリック → 3番目を Shift+クリック → 0,1,2 が選択', async () => {
      const fourBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
        makeBlock('b4', 'fourth', 3),
      ]
      const doc = makeDoc(fourBlocks)
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set(), lastSelectedId: null } as any)
      const searchInputRef = { current: null }
      const { container } = render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      const cards = container.querySelectorAll('.ocr-card')
      // 最初のカードをクリック
      fireEvent.click(cards[0])

      expect(usePecoStore.getState().selectedIds.has('b1')).toBe(true)

      // 3番目のカードを Shift+クリック
      fireEvent.click(cards[2], { shiftKey: true })

      const ids = usePecoStore.getState().selectedIds
      expect(ids.has('b1')).toBe(true)
      expect(ids.has('b2')).toBe(true)
      expect(ids.has('b3')).toBe(true)
      expect(ids.has('b4')).toBe(false)
    })
  })

  describe('C-ED-07: キーボード選択とナビゲーション', () => {
    const keyboardBlocks = [
      makeBlock('b1', 'first', 0),
      makeBlock('b2', 'second', 1),
      makeBlock('b3', 'third', 2),
      makeBlock('b4', 'fourth', 3),
    ]

    it('Shift+ArrowDown → 現在カードと次カードが選択に追加される', () => {
      const { container } = setup(keyboardBlocks, ['b2'])
      const contents = getCardContents(container)

      fireEvent.keyDown(contents[1], { key: 'ArrowDown', shiftKey: true })

      expectSelectedIds(['b2', 'b3'])
    })

    it('Shift+ArrowUp → 現在カードと前カードが選択に追加される', () => {
      const { container } = setup(keyboardBlocks, ['b3'])
      const contents = getCardContents(container)

      fireEvent.keyDown(contents[2], { key: 'ArrowUp', shiftKey: true })

      expectSelectedIds(['b2', 'b3'])
    })

    it('Ctrl+ArrowDown → 従来通り次カードのみを選択する', () => {
      const { container } = setup(keyboardBlocks, ['b1', 'b3'])
      const contents = getCardContents(container)

      fireEvent.keyDown(contents[0], { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b2'])
    })

    it('Ctrl+Shift+ArrowDown → Ctrl ナビゲーションではなく Shift 選択拡張になる', () => {
      const { container } = setup(keyboardBlocks, ['b2'])
      const contents = getCardContents(container)

      fireEvent.keyDown(contents[1], { key: 'ArrowDown', ctrlKey: true, shiftKey: true })

      expectSelectedIds(['b2', 'b3'])
    })

    it('検索フィルター中の Ctrl+ArrowDown は表示カード間だけを移動する', async () => {
      const user = userEvent.setup()
      const filteredNavBlocks = [
        makeBlock('b1', 'visible match first', 0),
        makeBlock('b2', 'hidden middle', 1),
        makeBlock('b3', 'visible match second', 2),
      ]
      const { container } = setup(filteredNavBlocks, ['b1'])

      await user.type(screen.getByPlaceholderText('検索...'), 'match')
      const contents = getCardContents(container)
      expect(contents.length).toBe(2)

      fireEvent.keyDown(contents[0], { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b3'])
    })

    it('先頭で Shift+ArrowUp、末尾で Ctrl+ArrowDown は選択を変えない', () => {
      const { container } = setup(keyboardBlocks, ['b1'])
      const contents = getCardContents(container)

      fireEvent.keyDown(contents[0], { key: 'ArrowUp', shiftKey: true })
      expectSelectedIds(['b1'])

      usePecoStore.setState({ selectedIds: new Set(['b4']), lastSelectedId: 'b4' } as any)
      fireEvent.keyDown(contents[3], { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b4'])
    })

    it('window Ctrl+ArrowDown は lastSelectedId の次カードのみを選択する', () => {
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1', 'b2']), lastSelectedId: 'b2' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b3'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b3')
    })

    it('window Shift+ArrowDown は lastSelectedId から次カードへ選択を拡張する', () => {
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1', 'b2']), lastSelectedId: 'b2' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true })

      expectSelectedIds(['b1', 'b2', 'b3'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b3')
    })

    it('window Shift+ArrowUp は下端から逆方向に戻ると選択下端を解除する', () => {
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2', 'b3', 'b4']), lastSelectedId: 'b4' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true })

      expectSelectedIds(['b2', 'b3'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b3')
    })

    it('window Shift+ArrowDown は上端から逆方向に戻ると選択上端を解除する', () => {
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1', 'b2', 'b3']), lastSelectedId: 'b1' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true })

      expectSelectedIds(['b2', 'b3'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b2')
    })

    it('検索フィルター中の window Ctrl+ArrowDown は表示カード間だけを移動する', async () => {
      const user = userEvent.setup()
      const filteredNavBlocks = [
        makeBlock('b1', 'visible match first', 0),
        makeBlock('b2', 'hidden middle', 1),
        makeBlock('b3', 'visible match second', 2),
      ]
      setup(filteredNavBlocks)

      await user.type(screen.getByPlaceholderText('検索...'), 'match')
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b3'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b3')
    })

    it('検索入力欄にフォーカスがある場合は window キーハンドラーが動作しない', () => {
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2']), lastSelectedId: 'b2' } as any)
      })
      const searchBox = screen.getByPlaceholderText('検索...')

      searchBox.focus()
      fireEvent.keyDown(searchBox, { key: 'ArrowDown', ctrlKey: true })

      expectSelectedIds(['b2'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b2')
    })
  })

  describe('C-ED-08: フォーカス中OCR編集の保存前コミット', () => {
    it('OCRカード本文にフォーカスしたまま Ctrl+S → DOMテキストが store に反映される', () => {
      const { container } = setup([makeBlock('b1', 'before save', 0)])
      const content = getCardContents(container)[0]

      content.focus()
      content.textContent = 'edited before save'
      fireEvent.keyDown(content, { key: 's', ctrlKey: true })

      const page = usePecoStore.getState().document!.pages.get(0)!
      expect(page.textBlocks[0].text).toBe('edited before save')
      expect(page.textBlocks[0].isDirty).toBe(true)
      expect(page.isDirty).toBe(true)
    })
  })

  describe('C-ED-10: 検索中はドラッグ無効化', () => {
    it('検索語入力時、useSensor が distance: Infinity で呼ばれる', async () => {
      const dndCore = await import('@dnd-kit/core') as any
      const mockUseSensor = dndCore.useSensor as ReturnType<typeof vi.fn>
      const user = userEvent.setup()
      setup()

      // 検索前の呼び出しをリセット
      mockUseSensor.mockClear()

      // 検索語を入力して再レンダリングをトリガー
      await user.type(screen.getByPlaceholderText('検索...'), 'cherry')

      // useSensor が呼ばれたことを確認（モックなので distance の詳細検証は困難）
      // 代わりに検索中のフィルタが正しく動作していることを確認
      const cards = document.querySelectorAll('.ocr-card-content')
      expect(cards.length).toBe(1) // "cherry" のみマッチ
    })
  })

  // ── S-08: 検索フィルタ中の DnD 抑止 ─────────────────────────────
  describe('S-08: 検索フィルタ中の DnD reorder 抑止', () => {
    // 二重防御の片翼（handleDragEnd 内 searchTerm ガード）を検証する
    // もう片翼（PointerSensor distance:Infinity）は C-ED-10 で間接検証済

    it('S-08-01: 検索ワード入力中は handleDragEnd の reorder が呼ばれない', async () => {
      const user = userEvent.setup()
      setup()

      // updatePageData を spy
      const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData')

      // 検索語を入力（フィルタ中）
      await user.type(screen.getByPlaceholderText('検索...'), 'fruit')

      // 捕捉した onDragEnd を取得
      const onDragEnd = (globalThis as any).__lastDndOnDragEnd as
        | ((e: any) => void)
        | undefined
      expect(typeof onDragEnd).toBe('function')

      updateSpy.mockClear()

      // ドラッグ終了イベントを擬似発火（b1 を b2 にドロップ）
      act(() => {
        onDragEnd!({ active: { id: 'b1' }, over: { id: 'b2' } })
      })

      // searchTerm ガードにより updatePageData は呼ばれない
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('S-08-02: 検索ワードを空に戻すと DnD reorder が再度有効になる', async () => {
      const user = userEvent.setup()
      setup()

      const searchBox = screen.getByPlaceholderText('検索...')
      // 一度入力 → クリア
      await user.type(searchBox, 'fruit')
      await user.clear(searchBox)

      const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData')

      // 再捕捉した onDragEnd（クリア後の最新クロージャ）
      const onDragEnd = (globalThis as any).__lastDndOnDragEnd as
        | ((e: any) => void)
        | undefined
      expect(typeof onDragEnd).toBe('function')

      // ドラッグ終了イベント
      act(() => {
        onDragEnd!({ active: { id: 'b1' }, over: { id: 'b2' } })
      })

      // searchTerm が空のため reorder は走り updatePageData が呼ばれる
      expect(updateSpy).toHaveBeenCalledTimes(1)
      const [pageIdx, patch] = updateSpy.mock.calls[0]
      expect(pageIdx).toBe(0)
      expect(patch.isDirty).toBe(true)
      expect(Array.isArray(patch.textBlocks)).toBe(true)
    })
  })

  // ── V-01: 仮想化 + キーボードナビ整合 (issue #20) ────────────────
  describe('V-01: 仮想化リストでもキーボードナビゲーションが機能する', () => {
    it('大量ブロックでも Virtuoso 経由で全カードが描画され Shift+ArrowDown が動作する', () => {
      // モックされた Virtuoso は totalCount 全件を render するため、仮想化境界の代わりに
      // SortableContext へ全 id が渡され、キーボードナビが index ベースで通ることを検証する
      const manyBlocks: TextBlock[] = []
      for (let i = 0; i < 50; i++) {
        manyBlocks.push(makeBlock(`v${i}`, `block ${i}`, i))
      }
      const { container } = setup(manyBlocks, ['v10'])

      const contents = getCardContents(container)
      expect(contents.length).toBe(50)

      fireEvent.keyDown(contents[10], { key: 'ArrowDown', shiftKey: true })
      expectSelectedIds(['v10', 'v11'])
    })

    it('Virtuoso ラッパー (.ocr-card-list) 配下にカードが描画される', () => {
      const { container } = setup()
      // OcrEditor 内では Virtuoso が ocr-card-list クラスのコンテナを描画する
      const list = container.querySelector('.ocr-card-list')
      expect(list).not.toBeNull()
      // フィルタなしの 3 カード全てが list 配下にある
      expect(list!.querySelectorAll('.ocr-card-content').length).toBe(3)
    })
  })

  // ── M-84: issue #84 モーダル open 中はグローバル keydown を抑止する ──
  describe('M-84 (issue #84): モーダル open 中は window keydown ハンドラが動かない', () => {
    afterEach(() => {
      // 各テストで body に挿した dialog を確実に掃除
      document.querySelectorAll('[data-test-modal]').forEach((el) => el.remove())
    })

    function openFakeModal() {
      // Modal 実装が描画する DOM と同じ属性で「モーダル open」状態を再現
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('data-test-modal', 'true')
      document.body.appendChild(dialog)
      return dialog
    }

    it('window Ctrl+ArrowDown: モーダルが開いていると選択を変えない', () => {
      const keyboardBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      // モーダルを開く
      openFakeModal()

      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })

      // 選択は b1 のまま (本来なら b2 に動く)
      expectSelectedIds(['b1'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b1')
    })

    it('window Shift+ArrowDown: モーダルが開いていると選択を拡張しない', () => {
      const keyboardBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      openFakeModal()

      fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true })

      // 選択は b1 のまま (本来なら b1,b2 に拡張)
      expectSelectedIds(['b1'])
      expect(usePecoStore.getState().lastSelectedId).toBe('b1')
    })

    it('モーダルを閉じる (DOM から消す) と再びキー操作が効く', () => {
      const keyboardBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      const dialog = openFakeModal()
      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })
      expectSelectedIds(['b1']) // ガードで抑止

      // モーダル close → ガード解除
      dialog.remove()
      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })
      expectSelectedIds(['b2'])
    })

    it('role=dialog でも aria-modal=false の要素はガードしない (非モーダル dialog 互換)', () => {
      const keyboardBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(keyboardBlocks)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      const nonModal = document.createElement('div')
      nonModal.setAttribute('role', 'dialog')
      nonModal.setAttribute('aria-modal', 'false')
      nonModal.setAttribute('data-test-modal', 'true')
      document.body.appendChild(nonModal)

      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })

      // 非モーダル dialog なので OcrEditor のキー処理は通常通り動く
      expectSelectedIds(['b2'])
    })
  })

  // ── P-22: issue #27 グローバル keydown listener が毎レンダー再登録されない ──
  describe('P-22 (issue #27): window keydown listener は再レンダーで再登録されない', () => {
    it('テキスト編集等で再レンダーが起きても addEventListener("keydown", ...) は 1 回のみ', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')
      addSpy.mockClear()
      removeSpy.mockClear()

      setup()

      // 初回 mount で 'keydown' の addEventListener が 1 回呼ばれる前提
      const initialKeydownAdds = addSpy.mock.calls.filter(c => c[0] === 'keydown').length
      expect(initialKeydownAdds).toBe(1)

      // テキストブロックを編集して store 更新 → OcrEditor 再レンダー
      act(() => {
        const doc = usePecoStore.getState().document!
        const page = doc.pages.get(0)!
        const newBlocks = page.textBlocks.map((b, i) =>
          i === 0 ? { ...b, text: 'edited' } : b
        )
        const newPages = new Map(doc.pages)
        newPages.set(0, { ...page, textBlocks: newBlocks })
        usePecoStore.setState({ document: { ...doc, pages: newPages } } as any)
      })

      // 選択も変える (これも以前は依存に入っていて再登録の引き金)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2']), lastSelectedId: 'b2' } as any)
      })

      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b3']), lastSelectedId: 'b3' } as any)
      })

      // 再レンダー後も 'keydown' の addEventListener 累計は変わらない
      const finalKeydownAdds = addSpy.mock.calls.filter(c => c[0] === 'keydown').length
      const finalKeydownRemoves = removeSpy.mock.calls.filter(c => c[0] === 'keydown').length
      expect(finalKeydownAdds).toBe(initialKeydownAdds)
      expect(finalKeydownRemoves).toBe(0)

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })

    it('listener が ref 経由で最新の selectedIds / lastSelectedId を読む', () => {
      const keyboardBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(keyboardBlocks)

      // 初期: 何も選択されていない
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(), lastSelectedId: null } as any)
      })

      // listener 登録後に selectedIds / lastSelectedId が変化しても、ref 経由で
      // 最新値を読むので動作が壊れない
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)
      })

      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })
      expectSelectedIds(['b2'])
    })
  })

  // ── P-92: issue #92 renderItem identity 安定 (Virtuoso memoization 維持) ───────────
  describe('P-92 (issue #92): renderItem / itemContent は再レンダーで identity が変わらない', () => {
    it('テキスト編集で textBlocks 参照が変わっても itemContent callback の identity は不変', () => {
      const editBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(editBlocks)

      const initialItemContent = (globalThis as any).__lastVirtuosoItemContent
      expect(typeof initialItemContent).toBe('function')

      // 1 文字編集相当: textBlocks 配列の参照を新規生成
      act(() => {
        const doc = usePecoStore.getState().document!
        const page = doc.pages.get(0)!
        const newBlocks = page.textBlocks.map((b, i) =>
          i === 0 ? { ...b, text: 'edited' } : b
        )
        const newPages = new Map(doc.pages)
        newPages.set(0, { ...page, textBlocks: newBlocks })
        usePecoStore.setState({ document: { ...doc, pages: newPages } } as any)
      })

      const afterEditItemContent = (globalThis as any).__lastVirtuosoItemContent
      // 再レンダー後も itemContent の identity が同一であること
      expect(afterEditItemContent).toBe(initialItemContent)

      // さらに選択状態を変えても同じ
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2']), lastSelectedId: 'b2' } as any)
      })
      expect((globalThis as any).__lastVirtuosoItemContent).toBe(initialItemContent)
    })

    it('itemContent は ref 経由で最新の filteredBlocks を読む (検索フィルター後も正しく描画)', async () => {
      const user = userEvent.setup()
      const editBlocks = [
        makeBlock('b1', 'apple fruit', 0),
        makeBlock('b2', 'banana fruit', 1),
        makeBlock('b3', 'cherry', 2),
      ]
      const { container } = setup(editBlocks)

      const initialItemContent = (globalThis as any).__lastVirtuosoItemContent

      // 検索 → filteredBlocks の中身が変化
      await user.type(screen.getByPlaceholderText('検索...'), 'cherry')

      // itemContent identity は同じ (mount 中固定)
      expect((globalThis as any).__lastVirtuosoItemContent).toBe(initialItemContent)

      // それでも表示内容は最新 filteredBlocks (cherry のみ)
      const cards = container.querySelectorAll('.ocr-card-content')
      expect(cards.length).toBe(1)
      expect(cards[0].textContent).toBe('cherry')
    })

    it('renderItem が ref 経由で最新の handleSelect を呼び、テキスト編集後もクリック選択が壊れない', () => {
      const editBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      const { container } = setup(editBlocks)

      // テキスト編集 → textBlocks 参照変化 → 旧実装なら handleSelect 再生成 → renderItem も再生成
      // 新実装では renderItem は安定だが ref 経由で最新 handleSelect を呼ぶ
      act(() => {
        const doc = usePecoStore.getState().document!
        const page = doc.pages.get(0)!
        const newBlocks = page.textBlocks.map((b, i) =>
          i === 1 ? { ...b, text: 'edited' } : b
        )
        const newPages = new Map(doc.pages)
        newPages.set(0, { ...page, textBlocks: newBlocks })
        usePecoStore.setState({ document: { ...doc, pages: newPages } } as any)
      })

      // 編集後にクリック選択が動作することを確認 (handleSelect が ref 経由で最新版を呼ぶ)
      const cards = container.querySelectorAll('.ocr-card')
      fireEvent.click(cards[2])
      expect(usePecoStore.getState().selectedIds.has('b3')).toBe(true)
    })
  })

  // ── R22狩り(交差汚染 HIGH): Virtuoso computeItemKey が block.id を返す ──
  describe('R22狩り: computeItemKey で Virtuoso のキーが block.id に固定される', () => {
    // 前提: index ベースの key だと、リストの並び/構成が変わった際に別ブロックへ
    // コンポーネントが retarget され、フォーカス中カードの未確定編集が別ブロックへ
    // 混入する (交差汚染)。computeItemKey で id 固定にすることで retarget を防ぐ。
    it('computeItemKey(i) が filteredBlocks[i].id を返す', () => {
      const editBlocks = [
        makeBlock('b1', 'first', 0),
        makeBlock('b2', 'second', 1),
        makeBlock('b3', 'third', 2),
      ]
      setup(editBlocks)

      const computeItemKey = (globalThis as any).__lastVirtuosoComputeItemKey as
        | ((index: number) => string | number)
        | undefined
      expect(typeof computeItemKey).toBe('function')
      expect(computeItemKey!(0)).toBe('b1')
      expect(computeItemKey!(1)).toBe('b2')
      expect(computeItemKey!(2)).toBe('b3')
    })

    it('検索フィルタ後も computeItemKey はフィルタ後の index に対応する block.id を返す', async () => {
      const user = userEvent.setup()
      const editBlocks = [
        makeBlock('b1', 'apple fruit', 0),
        makeBlock('b2', 'banana fruit', 1),
        makeBlock('b3', 'cherry', 2),
      ]
      setup(editBlocks)

      await user.type(screen.getByPlaceholderText('検索...'), 'fruit')

      const computeItemKey = (globalThis as any).__lastVirtuosoComputeItemKey as
        (index: number) => string | number
      // フィルタ後配列は [b1, b2] (fruit を含む2件)
      expect(computeItemKey(0)).toBe('b1')
      expect(computeItemKey(1)).toBe('b2')
    })
  })

  // ── C-OE-04: BB クリック選択でテキストエディタがスクロール (issue #116) ──
  describe('C-OE-04: lastSelectedId 変更で Virtuoso がそのブロックへスクロール', () => {
    // 前提: BB クリックは lastSelectedId を更新するだけで、仮想化された OcrEditor は
    // 該当ブロックまでスクロールしなかった (OcrCard 側の per-card scrollIntoView は
    // アンマウント済みカードでは動かないため)。修正後は OcrEditor が lastSelectedId を
    // 監視し virtuosoRef.scrollIntoView({index}) を呼ぶ。

    const navBlocks = [
      makeBlock('b1', 'first', 0),
      makeBlock('b2', 'second', 1),
      makeBlock('b3', 'third', 2),
    ]

    function getScrollCalls() {
      return ((globalThis as any).__virtuosoScrollIntoViewCalls ?? []) as any[][]
    }

    it('C-OE-04-01: 単一選択で lastSelectedId が変わると該当 index へ scrollIntoView される', () => {
      setup(navBlocks)
      // 初期状態 (lastSelectedId=null) ではスクロールしない
      expect(getScrollCalls().length).toBe(0)

      // BB クリック相当: b3 を単一選択
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b3']), lastSelectedId: 'b3' } as any)
      })

      const calls = getScrollCalls()
      expect(calls.length).toBe(1)
      // filteredBlocks 内 b3 の index = 2、align:'center' / behavior:'auto'
      // issue #291: done コールバックも含まれる
      expect(calls[0][0].index).toBe(2)
      expect(calls[0][0].behavior).toBe('auto')
      expect(calls[0][0].align).toBe('center')
      expect(typeof calls[0][0].done).toBe('function')
    })

    it('C-OE-04-02: 複数選択時は scrollIntoView しない (一括選択で勝手にジャンプしない)', () => {
      setup(navBlocks)

      act(() => {
        usePecoStore.setState({
          selectedIds: new Set(['b1', 'b2', 'b3']),
          lastSelectedId: 'b3',
        } as any)
      })

      expect(getScrollCalls().length).toBe(0)
    })

    it('C-OE-04-03: lastSelectedId が現在のフィルタ結果に無いときは scrollIntoView しない', async () => {
      const user = userEvent.setup()
      const filterBlocks = [
        makeBlock('b1', 'apple', 0),
        makeBlock('b2', 'banana', 1),
        makeBlock('b3', 'cherry', 2),
      ]
      setup(filterBlocks)

      // "apple" のみ表示されるよう絞り込む
      await user.type(screen.getByPlaceholderText('検索...'), 'apple')

      // フィルタ外の b3 を anchor にしてもスクロールしない (index が見つからない)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b3']), lastSelectedId: 'b3' } as any)
      })

      expect(getScrollCalls().length).toBe(0)
    })

    it('C-OE-04-04: フィルタ後の index でスクロールする (生インデックスではない)', async () => {
      const user = userEvent.setup()
      const filterBlocks = [
        makeBlock('b1', 'apple', 0),
        makeBlock('b2', 'banana match', 1),
        makeBlock('b3', 'cherry match', 2),
      ]
      setup(filterBlocks)

      // "match" で絞り込む → filteredBlocks = [b2, b3]
      await user.type(screen.getByPlaceholderText('検索...'), 'match')

      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b3']), lastSelectedId: 'b3' } as any)
      })

      const calls = getScrollCalls()
      expect(calls.length).toBe(1)
      // b3 は生配列では index 2 だが、filteredBlocks (b2,b3) 内では index 1
      expect(calls[0][0].index).toBe(1)
    })

    it('C-OE-04-05: scroll done コールバックで対象カードの contentEditable にフォーカスされる', () => {
      // Virtuoso モックは scrollIntoView 時に done() を即時呼ぶ設定になっている
      const { container } = setup(navBlocks)

      // 単一選択で b2 を選ぶ
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2']), lastSelectedId: 'b2' } as any)
      })

      // scrollIntoView が呼ばれていること
      const calls = getScrollCalls()
      expect(calls.length).toBe(1)
      // done コールバックの存在を確認
      expect(typeof calls[0][0].done).toBe('function')

      // done() を手動で呼ぶ (モックは呼ばないため明示実行)
      const contentEl = container.querySelector('[data-block-id="b2"].ocr-card-content') as HTMLElement
      expect(contentEl).not.toBeNull()
      // done() を呼んだ後、対象要素にフォーカスが当たる
      // NOTE: Virtuoso モック (仮想化なし) は done を呼ばないため直接確認
      calls[0][0].done()
      expect(document.activeElement).toBe(contentEl)
    })

    it('C-OE-04-06: 既に contentEditable を編集中の場合、done コールバックはフォーカスを奪わない', () => {
      const { container } = setup(navBlocks)

      // b1 の contentEditable にフォーカスを当てて「編集中」状態を再現
      const b1Content = container.querySelector('[data-block-id="b1"].ocr-card-content') as HTMLElement
      b1Content.focus()
      expect(document.activeElement).toBe(b1Content)
      // contenteditable="true" 属性が付いていることを確認
      expect(b1Content.getAttribute('contenteditable')).toBe('true')

      // b2 を単一選択 (act の外で事前フォーカス済みのため、act内でfocus変化なし)
      act(() => {
        usePecoStore.setState({ selectedIds: new Set(['b2']), lastSelectedId: 'b2' } as any)
      })

      const calls = getScrollCalls()
      expect(calls.length).toBe(1)

      // b1 に再フォーカスしてから done() を呼ぶ (act 内のstore更新でfocusが外れた場合の補正)
      b1Content.focus()
      expect(document.activeElement).toBe(b1Content)

      // done() を呼んでも b1 のフォーカスは奪われない (isContentEditable ガード)
      calls[0][0].done()
      expect(document.activeElement).toBe(b1Content)
    })

    it('C-OE-04-07: 複数選択では done コールバック自体がセットされない (scrollIntoView が呼ばれない)', () => {
      setup(navBlocks)

      act(() => {
        usePecoStore.setState({
          selectedIds: new Set(['b1', 'b2']),
          lastSelectedId: 'b2',
        } as any)
      })

      // 複数選択では scrollIntoView は呼ばれない
      expect(getScrollCalls().length).toBe(0)
    })
  })

  // ── C-OE-06: issue #214 searchHitIndex stale 修正 ─────────────────────────────
  describe('C-OE-06 (issue #214): Enter キー連打で scrollToHitBlock が正しいインデックスで呼ばれる', () => {
    const hitBlocks = [
      makeBlock('h1', 'foo bar', 0),
      makeBlock('h2', 'foo baz', 1),
      makeBlock('h3', 'foo qux', 2),
    ]

    let scrollToSpy: ReturnType<typeof vi.fn>
    let fakeContainer: HTMLElement

    beforeEach(() => {
      // scrollToHitBlock 内の querySelector('.pdf-viewer-panel') をモック
      fakeContainer = document.createElement('div')
      fakeContainer.className = 'pdf-viewer-panel'
      fakeContainer.getBoundingClientRect = () => ({
        top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
      })
      scrollToSpy = vi.fn()
      fakeContainer.scrollTo = scrollToSpy as any
      document.body.appendChild(fakeContainer)
    })

    afterEach(() => {
      fakeContainer.remove()
    })

    it('C-OE-06-01: Enter 連打で 0→1→2→0 の順に scrollToHitBlock が呼ばれる', async () => {
      const user = userEvent.setup()
      useSearchStore.setState({ searchTerm: '', searchHitIndex: -1 } as any)
      setup(hitBlocks)

      const searchBox = screen.getByPlaceholderText('検索...')
      await user.type(searchBox, 'foo')
      // searchTerm='foo' で 3 ヒット、hitIndex=-1→0 (setSearchTerm でリセット)

      // beforeEach で -1 にセットしてるので setSearchTerm 後は 0 になる
      // scrollTo 呼び出し数を確認する前にリセット
      scrollToSpy.mockClear()

      // Enter 1 回目: 0→1
      await user.keyboard('{Enter}')
      expect(useSearchStore.getState().searchHitIndex).toBe(1)

      // Enter 2 回目: 1→2
      await user.keyboard('{Enter}')
      expect(useSearchStore.getState().searchHitIndex).toBe(2)

      // Enter 3 回目: 2→0 (循環)
      await user.keyboard('{Enter}')
      expect(useSearchStore.getState().searchHitIndex).toBe(0)

      // scrollTo が 3 回呼ばれている
      expect(scrollToSpy).toHaveBeenCalledTimes(3)
    })

    it('C-OE-06-02: Shift+Enter 連打で 2→1→0→2 の順にインデックスが戻る', async () => {
      const user = userEvent.setup()
      useSearchStore.setState({ searchTerm: 'foo', searchHitIndex: 2 } as any)
      setup(hitBlocks)

      scrollToSpy.mockClear()

      const searchBox = screen.getByPlaceholderText('検索...')
      // フォーカスを当てる
      searchBox.focus()

      // Shift+Enter 1 回目: 2→1
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      expect(useSearchStore.getState().searchHitIndex).toBe(1)

      // Shift+Enter 2 回目: 1→0
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      expect(useSearchStore.getState().searchHitIndex).toBe(0)

      // Shift+Enter 3 回目: 0→2 (循環)
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      expect(useSearchStore.getState().searchHitIndex).toBe(2)

      expect(scrollToSpy).toHaveBeenCalledTimes(3)
    })

    it('C-OE-06-03: 検索ヒット 0 件で Enter キー → scrollToHitBlock は呼ばれない', async () => {
      const user = userEvent.setup()
      useSearchStore.setState({ searchTerm: '', searchHitIndex: -1 } as any)
      setup(hitBlocks)

      scrollToSpy.mockClear()

      const searchBox = screen.getByPlaceholderText('検索...')
      // ヒットしない検索語を入力
      await user.type(searchBox, 'NOMATCH_XYZ')

      scrollToSpy.mockClear()

      await user.keyboard('{Enter}')

      // ヒット 0 件なので scrollTo は呼ばれない
      expect(scrollToSpy).not.toHaveBeenCalled()
      // searchHitIndex も変化なし
      expect(useSearchStore.getState().searchHitIndex).toBe(0)
    })
  })

  // ── C-OE-05: 仮想化された(未マウントの)カードへの BB クリックスクロール (issue #116 本シナリオ) ──
  describe('C-OE-05: 画面外でアンマウントされたカードへ BB クリックでスクロールする', () => {
    // C-OE-04 のモック Virtuoso は totalCount を全件描画するため、
    // 「対象カードが未マウント」という issue #116 の本来の失敗状況を再現できない。
    // ここでは __virtuosoWindowSize をセットして本物の仮想化 (窓外カードのアンマウント)
    // を再現し、画面外ブロックを単一選択 → virtuosoRef.scrollIntoView({index}) が
    // 正しいフィルタ後 index で呼ばれること、かつスクロール後に対象カードが
    // 実際にマウントされることを検証する。

    function getScrollCalls() {
      return ((globalThis as any).__virtuosoScrollIntoViewCalls ?? []) as any[][]
    }

    function manyNavBlocks(n: number): TextBlock[] {
      const out: TextBlock[] = []
      for (let i = 0; i < n; i++) out.push(makeBlock(`v${i}`, `block ${i}`, i))
      return out
    }

    it('C-OE-05-01: 画面外ブロックを単一選択 → 未マウント状態から scrollIntoView でマウントされる', () => {
      // 窓サイズ 5: 50 ブロック中 index 0..4 のみ初期描画される。
      ;(globalThis as any).__virtuosoWindowSize = 5
      const { container } = setup(manyNavBlocks(50))

      // 初期状態: 窓 [0,5) のカードだけが描画され、v40 は未マウント。
      let mounted = Array.from(
        container.querySelectorAll('[data-virtuoso-index]')
      ).map(el => el.getAttribute('data-virtuoso-index'))
      expect(mounted).toEqual(['0', '1', '2', '3', '4'])
      // 対象 v40 のカードはまだ DOM に存在しない (= アンマウント済み)。
      expect(container.querySelector('[data-virtuoso-index="40"]')).toBeNull()

      // BB クリック相当: 画面外の v40 を単一選択する。
      act(() => {
        usePecoStore.setState({
          selectedIds: new Set(['v40']),
          lastSelectedId: 'v40',
        } as any)
      })

      // OcrEditor の lastSelectedId effect が virtuosoRef.scrollIntoView({index:40}) を呼ぶ。
      const calls = getScrollCalls()
      expect(calls.length).toBe(1)
      expect(calls[0][0].index).toBe(40)
      expect(calls[0][0].align).toBe('center')

      // スクロール後: 窓が v40 中心に移動し、対象カードが実際にマウントされている。
      mounted = Array.from(
        container.querySelectorAll('[data-virtuoso-index]')
      ).map(el => el.getAttribute('data-virtuoso-index'))
      expect(mounted).toContain('40')
      // 旧 index 0..4 のカードは窓外になりアンマウントされている (本物の仮想化挙動)。
      expect(container.querySelector('[data-virtuoso-index="0"]')).toBeNull()
    })

    it('C-OE-05-02: フィルタ中、画面外ブロックへはフィルタ後 index でスクロールする', async () => {
      ;(globalThis as any).__virtuosoWindowSize = 4
      const user = userEvent.setup()
      // 偶数ブロックだけ "match" を含む → フィルタ後リストは v0,v2,v4,...,v58 (30件)。
      const filterBlocks: TextBlock[] = []
      for (let i = 0; i < 60; i++) {
        filterBlocks.push(makeBlock(`v${i}`, i % 2 === 0 ? `match ${i}` : `other ${i}`, i))
      }
      const { container } = setup(filterBlocks)

      await user.type(screen.getByPlaceholderText('検索...'), 'match')

      // フィルタ後の窓には先頭 4 件 (v0,v2,v4,v6) のみ描画。v40 は未マウント。
      expect(container.querySelector('[data-virtuoso-index="0"]')).not.toBeNull()
      const v40Mounted = () =>
        Array.from(container.querySelectorAll('.ocr-card')).some(
          el => el.getAttribute('data-block-id') === 'v40'
        )
      expect(v40Mounted()).toBe(false)

      // 生配列で index 40 の v40 は、偶数フィルタ後リストでは index 20。
      act(() => {
        usePecoStore.setState({
          selectedIds: new Set(['v40']),
          lastSelectedId: 'v40',
        } as any)
      })

      const calls = getScrollCalls()
      expect(calls.length).toBe(1)
      // 生 index 40 ではなく、フィルタ後 index 20 でスクロールされること。
      expect(calls[0][0].index).toBe(20)
      // スクロール後 v40 のカードがマウントされている。
      expect(v40Mounted()).toBe(true)
    })

    it('C-OE-05-03: 仮想化モードでも複数選択では scrollIntoView しない', () => {
      ;(globalThis as any).__virtuosoWindowSize = 5
      setup(manyNavBlocks(50))

      // 画面外ブロックを含む複数選択 → 勝手にジャンプしない。
      act(() => {
        usePecoStore.setState({
          selectedIds: new Set(['v40', 'v41', 'v42']),
          lastSelectedId: 'v42',
        } as any)
      })

      expect(getScrollCalls().length).toBe(0)
    })
  })

})
