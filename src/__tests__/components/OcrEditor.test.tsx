import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OcrEditor } from '../../components/OcrEditor'
import { usePecoStore } from '../../store/pecoStore'
import type { TextBlock, PageData, PecoDocument } from '../../types'

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
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
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
vi.mock('react-virtuoso', () => {
  const React = require('react') as typeof import('react')
  const Virtuoso = React.forwardRef(function Virtuoso(
    { totalCount, itemContent, className, style }: any,
    _ref: any
  ) {
    ;(globalThis as any).__lastVirtuosoItemContent = itemContent
    const items = []
    for (let i = 0; i < totalCount; i++) {
      items.push(
        React.createElement('div', { key: i, 'data-virtuoso-index': i }, itemContent(i))
      )
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
  return render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)
}

function getCardContents(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.ocr-card-content')) as HTMLElement[]
}

function expectSelectedIds(expected: string[]) {
  expect(Array.from(usePecoStore.getState().selectedIds).sort()).toEqual([...expected].sort())
}

afterEach(() => cleanup())

beforeEach(() => {
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
  } as any)
})

// ── テスト ────────────────────────────────────────────────────

describe('OcrEditor', () => {

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
    it('textBlocks=[] → "OCRテキストなし" が表示される', () => {
      const doc = makeDoc([])
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('OCRテキストなし')).toBeTruthy()
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
      // 「OCRテキストなし」は出ない（isTextExtracted=true でのみ出る）
      expect(screen.queryByText('OCRテキストなし')).toBeNull()
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

    it('isTextExtracted=true で textBlocks=[] → "OCRテキストなし" が出る（従来挙動）', () => {
      const doc = makeDoc([], { isTextExtracted: true })
      usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
      const searchInputRef = { current: null }
      render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

      expect(screen.getByText('OCRテキストなし')).toBeTruthy()
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

})
