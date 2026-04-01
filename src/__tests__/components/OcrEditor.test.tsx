import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OcrEditor } from '../../components/OcrEditor'
import { usePecoStore } from '../../store/pecoStore'
import type { TextBlock, PageData, PecoDocument } from '../../types'

// DnD kit をスタブ化（検索フィルターテストに不要）
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  closestCenter: null,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn().mockReturnValue(null),
  useSensors: vi.fn().mockReturnValue([]),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  arrayMove: vi.fn(),
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

function makeDoc(blocks: TextBlock[]): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
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

function setup() {
  const doc = makeDoc(blocks)
  usePecoStore.setState({ document: doc, currentPageIndex: 0, selectedIds: new Set() } as any)
  return render(<OcrEditor width={350} />)
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

})
