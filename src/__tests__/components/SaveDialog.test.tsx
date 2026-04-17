import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SaveDialog } from '../../components/SaveDialog'

vi.mock('lucide-react', () => ({
  X: () => null,
  Loader2: (props: any) => <span className={props.className}>loading</span>,
}))

// ── ヘルパー ──────────────────────────────────────────────────

function renderDialog(overrides: Partial<Parameters<typeof SaveDialog>[0]> = {}) {
  const defaults = {
    isEstimating: false,
    estimatedSizes: { uncompressed: 2097152, compressed: 1048576 },
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    defaultCompression: 'none' as const,
    defaultRasterizeQuality: 60,
  }
  const props = { ...defaults, ...overrides }
  const utils = render(<SaveDialog {...props} />)
  return { ...utils, props }
}

// ── テスト ───────────────────────────────────────────────────

describe('SaveDialog', () => {
  afterEach(cleanup)

  it('C-SD-01: renders 3 radio inputs', () => {
    renderDialog()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
  })

  it('C-SD-02: defaultCompression pre-selected', () => {
    const { container } = renderDialog({ defaultCompression: 'compressed' })
    const compressed = container.querySelector('input[type="radio"][value="compressed"]') as HTMLInputElement
    expect(compressed.checked).toBe(true)
  })

  it('C-SD-03: uncompressed size displayed', () => {
    renderDialog({ estimatedSizes: { uncompressed: 2097152, compressed: 1048576 } })
    expect(screen.getByText('2 MB')).toBeTruthy()
  })

  it('C-SD-04: compressed size with reduction %', () => {
    renderDialog({ estimatedSizes: { uncompressed: 2097152, compressed: 1048576 } })
    expect(screen.getByText('1 MB (50% 削減)')).toBeTruthy()
  })

  it('C-SD-05: isEstimating=true shows spinner', () => {
    const { container } = renderDialog({ isEstimating: true })
    const spinners = container.querySelectorAll('.spin')
    expect(spinners.length).toBeGreaterThan(0)
  })

  it('C-SD-06: rasterized selected shows JPEG quality slider', () => {
    renderDialog({ defaultCompression: 'rasterized' })
    const slider = screen.getByRole('slider')
    expect(slider).toBeTruthy()
    expect((slider as HTMLInputElement).type).toBe('range')
  })

  it('C-SD-07: confirm with compressed calls onConfirm("compressed", 60)', () => {
    const { props } = renderDialog({ defaultCompression: 'compressed' })
    fireEvent.click(screen.getByText('保存する'))
    expect(props.onConfirm).toHaveBeenCalledWith('compressed', 60)
  })

  it('C-SD-08: confirm with rasterized + quality=80 calls onConfirm("rasterized", 80)', () => {
    const { props } = renderDialog({ defaultCompression: 'rasterized', defaultRasterizeQuality: 80 })
    fireEvent.click(screen.getByText('保存する'))
    expect(props.onConfirm).toHaveBeenCalledWith('rasterized', 80)
  })

  it('C-SD-09: cancel button calls onCancel', () => {
    const { props } = renderDialog()
    fireEvent.click(screen.getByText('キャンセル'))
    expect(props.onCancel).toHaveBeenCalled()
  })

  it('C-SD-10: X close button calls onCancel', () => {
    const { container, props } = renderDialog()
    const closeBtn = container.querySelector('.close-btn') as HTMLElement
    fireEvent.click(closeBtn)
    expect(props.onCancel).toHaveBeenCalled()
  })

  it('C-SD-11: estimatedSizes=null shows サイズ推定不可', () => {
    renderDialog({ estimatedSizes: null })
    const matches = screen.getAllByText('サイズ推定不可')
    expect(matches.length).toBeGreaterThan(0)
  })
})
