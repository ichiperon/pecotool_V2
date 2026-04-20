import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { createRef } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OcrCard, type OcrCardHandle } from '../../components/OcrCard'
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

  // ── S-05: IME 入力中の DOM 書換 skip ───────────────────────────
  describe('S-05: IME composition 中は DOM 書換を skip', () => {
    // 前提: OcrCard の useEffect は isComposingRef.current が true の間
    // contentRef.textContent への書換をスキップする（変換中の文字消失防止）

    it('S-05-01: compositionstart 後の props 更新では DOM textContent が書き換わらない', () => {
      const block = makeBlock({ text: 'あいう' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const { container, rerender } = render(<OcrCard block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // 初期値が同期されていることを確認
      expect(content.textContent).toBe('あいう')

      // composition 開始（変換中フラグを立てる）
      fireEvent.compositionStart(content)

      // 変換中ユーザーが DOM に未確定文字を入れた状態を再現
      content.textContent = 'あいうｋ'

      // 親から block.text props が更新される（外部更新を再現）
      const updatedBlock = { ...block, text: 'あいう更新' }
      act(() => {
        rerender(<OcrCard block={updatedBlock} pageIndex={0} />)
      })

      // composition 中なので DOM は書き換わらない（未確定文字が温存される）
      expect(content.textContent).toBe('あいうｋ')
    })

    it('S-05-02: compositionend 後の props 更新では DOM が通常通り反映される', () => {
      const block = makeBlock({ text: 'あいう' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const { container, rerender } = render(<OcrCard block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // composition 開始 → 終了
      fireEvent.compositionStart(content)
      fireEvent.compositionEnd(content)

      // フォーカスが当たっていない状態にしておく（activeElement ガードを外す）
      ;(content as HTMLElement).blur()

      // props 更新
      const updatedBlock = { ...block, text: 'あいう確定' }
      act(() => {
        rerender(<OcrCard block={updatedBlock} pageIndex={0} />)
      })

      // composition 終了後なので DOM が更新される
      expect(content.textContent).toBe('あいう確定')
    })

    it('S-05-03: composition 中に handleBlur が走っても textContent の値が store に保存される', () => {
      const block = makeBlock({ text: '元のテキスト' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const { container } = render(<OcrCard block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // composition 開始（未確定状態）
      fireEvent.compositionStart(content)
      content.textContent = '新テキスト'
      // composition 中に blur 発火
      fireEvent.blur(content)

      // textContent ベースで store に反映されている整合性確認
      const updated = usePecoStore.getState().document?.pages.get(0)?.textBlocks.find(b => b.id === 'block-1')
      expect(updated?.text).toBe('新テキスト')
      expect(updated?.isDirty).toBe(true)
    })
  })

  // ── S-06: キャレット位置復元（末尾固定でない） ────────────────
  describe('S-06: キャレット位置復元', () => {
    // jsdom の Selection API は anchorOffset / setStart / setEnd を概ねサポート

    function setCaret(_el: HTMLElement, textNode: Node, offset: number) {
      const sel = window.getSelection()!
      const range = window.document.createRange()
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      sel.removeAllRanges()
      sel.addRange(range)
    }

    it('S-06-01: 先頭から 3 文字目で blur → 再 focus でキャレットが offset 3 に復元', () => {
      const block = makeBlock({ text: 'abcdefghij' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const ref = createRef<OcrCardHandle>()
      const { container } = render(<OcrCard ref={ref} block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // フォーカス → キャレットを offset 3 に設定 → blur で保存
      content.focus()
      const textNode = content.firstChild!
      expect(textNode).toBeTruthy()
      setCaret(content, textNode, 3)
      fireEvent.blur(content)

      // 再 focus（focusContent 経由）で復元される
      act(() => {
        ref.current?.focusContent()
      })

      const sel = window.getSelection()!
      expect(sel.anchorOffset).toBe(3)
    })

    it('S-06-02: テキスト中間位置 offset 5 で blur → 再 focus で同じ offset に復元', () => {
      const block = makeBlock({ text: 'abcdefghij' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const ref = createRef<OcrCardHandle>()
      const { container } = render(<OcrCard ref={ref} block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      content.focus()
      const textNode = content.firstChild!
      setCaret(content, textNode, 5)
      fireEvent.blur(content)

      act(() => {
        ref.current?.focusContent()
      })

      const sel = window.getSelection()!
      expect(sel.anchorOffset).toBe(5)
      // 末尾 (10) ではないことを明示
      expect(sel.anchorOffset).not.toBe((textNode.textContent || '').length)
    })

    it('S-06-03: 保存位置が無い初回 focusContent では末尾に collapse する', () => {
      const block = makeBlock({ text: 'abcdef' })
      const page = makePage([block])
      const doc = makeDoc(new Map([[0, page]]))
      usePecoStore.setState({ document: doc })

      const ref = createRef<OcrCardHandle>()
      const { container } = render(<OcrCard ref={ref} block={block} pageIndex={0} />)
      const content = container.querySelector('.ocr-card-content') as HTMLElement

      // blur を経由していない（savedOffsetRef = null）状態で focusContent
      act(() => {
        ref.current?.focusContent()
      })

      const sel = window.getSelection()!
      // selectNodeContents + collapse(false) → 末尾位置
      // anchor は contentEditable 要素自身、anchorOffset は子ノード数（テキストノード1個 → 1）
      // または textNode 末尾（=textContent.length）になる実装差を吸収して両許容
      const len = (content.textContent || '').length
      const ok = sel.anchorOffset === len || sel.anchorOffset === content.childNodes.length
      expect(ok).toBe(true)
    })
  })

})
