import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OcrCard } from '../../components/OcrCard'
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

vi.mock('lucide-react', () => ({
  GripVertical: () => null,
}))

// ── ヘルパー ──────────────────────────────────────────────────

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'block-1',
    text: 'テスト',
    originalText: 'テスト',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  }
}

function makePage(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  }
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: '',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

// ── setup ──────────────────────────────────────────────────────

afterEach(() => cleanup())

beforeEach(() => {
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
  } as any)
})

// ── テスト ────────────────────────────────────────────────────

describe('OcrCard', () => {

  describe('C-OC-01: テキスト編集が store に反映', () => {
    it('contentEditable で blur → block.text 更新、isDirty=true', () => {
      const block = makeBlock()
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const { container } = render(<OcrCard block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // IME 統一により textContent 読取りへ変更された
      content.textContent = '新しいテキスト'
      fireEvent.blur(content)

      const updated = usePecoStore.getState().document?.pages.get(0)?.textBlocks.find(b => b.id === 'block-1')
      expect(updated?.text).toBe('新しいテキスト')
      expect(updated?.isDirty).toBe(true)
    })

    it('テキストが変化していない場合は store を更新しない', () => {
      const block = makeBlock({ text: 'テスト' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData')
      const { container } = render(<OcrCard block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // textContent を block.text と同じ値にする → 変化なし
      content.textContent = 'テスト'
      fireEvent.blur(content)

      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  describe('C-OC-02: 縦書きバッジ表示', () => {
    it('writingMode="vertical" → "縦書き" ラベルが表示', () => {
      render(<OcrCard block={makeBlock({ writingMode: 'vertical' })} pageIndex={0} />)
      expect(screen.getByText('縦書き')).toBeTruthy()
    })

    it('writingMode="horizontal" → "横書き" ラベルが表示', () => {
      render(<OcrCard block={makeBlock({ writingMode: 'horizontal' })} pageIndex={0} />)
      expect(screen.getByText('横書き')).toBeTruthy()
    })
  })

  describe('C-OC-03: writingMode トグル', () => {
    it('縦書きバッジをクリック → writingMode が "horizontal" に変わり isDirty=true', () => {
      const block = makeBlock({ writingMode: 'vertical' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      render(<OcrCard block={block} pageIndex={0} />)
      fireEvent.click(screen.getByText('縦書き'))

      const updated = usePecoStore.getState().document?.pages.get(0)?.textBlocks.find(b => b.id === 'block-1')
      expect(updated?.writingMode).toBe('horizontal')
      expect(updated?.isDirty).toBe(true)
    })

    it('横書きバッジをクリック → writingMode が "vertical" に変わる', () => {
      const block = makeBlock({ writingMode: 'horizontal' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      render(<OcrCard block={block} pageIndex={0} />)
      fireEvent.click(screen.getByText('横書き'))

      const updated = usePecoStore.getState().document?.pages.get(0)?.textBlocks.find(b => b.id === 'block-1')
      expect(updated?.writingMode).toBe('vertical')
    })
  })

  describe('C-OC-04: dirty インジケーター', () => {
    it('isDirty=true → "●" が表示される', () => {
      render(<OcrCard block={makeBlock({ isDirty: true })} pageIndex={0} />)
      expect(screen.getByText('●')).toBeTruthy()
    })

    it('isDirty=false → "●" が表示されない', () => {
      render(<OcrCard block={makeBlock({ isDirty: false })} pageIndex={0} />)
      expect(screen.queryByText('●')).toBeNull()
    })
  })

  describe('C-OC-05: 選択時のスタイル', () => {
    it('isSelected=true → card に "selected" クラスが付く', () => {
      usePecoStore.setState({ selectedIds: new Set(['block-1']) })
      const { container } = render(<OcrCard block={makeBlock()} pageIndex={0} />)
      expect(container.querySelector('.ocr-card.selected')).not.toBeNull()
    })

    it('isSelected=false → "selected" クラスが付かない', () => {
      usePecoStore.setState({ selectedIds: new Set() })
      const { container } = render(<OcrCard block={makeBlock()} pageIndex={0} />)
      expect(container.querySelector('.ocr-card.selected')).toBeNull()
    })
  })

  describe('C-OC-06: クリックで選択', () => {
    it('カードをクリック → toggleSelection が呼ばれ selectedIds に追加', () => {
      usePecoStore.setState({ selectedIds: new Set<string>() })
      const { container } = render(<OcrCard block={makeBlock()} pageIndex={0} />)

      const card = container.querySelector('.ocr-card') as HTMLElement
      fireEvent.click(card)

      expect(usePecoStore.getState().selectedIds.has('block-1')).toBe(true)
    })

    it('Ctrl+クリック → multi=true で追加選択', () => {
      usePecoStore.setState({ selectedIds: new Set(['other-block']) })
      const { container } = render(<OcrCard block={makeBlock()} pageIndex={0} />)

      const card = container.querySelector('.ocr-card') as HTMLElement
      fireEvent.click(card, { ctrlKey: true })

      const ids = usePecoStore.getState().selectedIds
      expect(ids.has('block-1')).toBe(true)
      expect(ids.has('other-block')).toBe(true)
    })
  })

  describe('C-OC-10: Ctrl+ArrowDown で次カードへナビゲート', () => {
    it('Ctrl+ArrowDown → onNavigate("down") が呼ばれる', () => {
      const onNavigate = vi.fn()
      const { container } = render(
        <OcrCard block={makeBlock()} pageIndex={0} onNavigate={onNavigate} />
      )
      const content = container.querySelector('.ocr-card-content') as HTMLElement
      fireEvent.keyDown(content, { key: 'ArrowDown', ctrlKey: true })

      expect(onNavigate).toHaveBeenCalledWith('down')
    })
  })

  describe('C-OC-11: Ctrl+ArrowUp で前カードへナビゲート', () => {
    it('Ctrl+ArrowUp → onNavigate("up") が呼ばれる', () => {
      const onNavigate = vi.fn()
      const { container } = render(
        <OcrCard block={makeBlock()} pageIndex={0} onNavigate={onNavigate} />
      )
      const content = container.querySelector('.ocr-card-content') as HTMLElement
      fireEvent.keyDown(content, { key: 'ArrowUp', ctrlKey: true })

      expect(onNavigate).toHaveBeenCalledWith('up')
    })
  })

  describe('C-OC-12: Ctrl なしの矢印キーではナビゲートしない', () => {
    it('ArrowDown (Ctrl なし) → onNavigate が呼ばれない', () => {
      const onNavigate = vi.fn()
      const { container } = render(
        <OcrCard block={makeBlock()} pageIndex={0} onNavigate={onNavigate} />
      )
      const content = container.querySelector('.ocr-card-content') as HTMLElement
      fireEvent.keyDown(content, { key: 'ArrowDown' })

      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('ArrowUp (Ctrl なし) → onNavigate が呼ばれない', () => {
      const onNavigate = vi.fn()
      const { container } = render(
        <OcrCard block={makeBlock()} pageIndex={0} onNavigate={onNavigate} />
      )
      const content = container.querySelector('.ocr-card-content') as HTMLElement
      fireEvent.keyDown(content, { key: 'ArrowUp' })

      expect(onNavigate).not.toHaveBeenCalled()
    })
  })

  describe('C-OC-16: 未選択カードの右クリックで選択', () => {
    it('selectedIds が空の状態で contextMenu → block.id が selectedIds に含まれる', () => {
      usePecoStore.setState({ selectedIds: new Set<string>() })
      const { container } = render(<OcrCard block={makeBlock()} pageIndex={0} />)

      const card = container.querySelector('.ocr-card') as HTMLElement
      fireEvent.contextMenu(card)

      expect(usePecoStore.getState().selectedIds.has('block-1')).toBe(true)
    })
  })

  describe('C-OC-17: order 番号の表示', () => {
    it('block.order=5 → "#6" が表示される', () => {
      render(<OcrCard block={makeBlock({ order: 5 })} pageIndex={0} />)
      expect(screen.getByText('#6')).toBeTruthy()
    })
  })

})
