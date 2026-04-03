import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PdfCanvas } from '../../components/PdfCanvas'
import { usePecoStore } from '../../store/pecoStore'
import * as pdfLoader from '../../utils/pdfLoader'

// ── Mocking ──────────────────────────────────────────────────

vi.mock('pdfjs-dist', () => ({
  default: {
    // pdfjs-dist global stuff if needed
  }
}));

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: vi.fn(),
}));

// mock getContext for Canvas
const mockContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  fillText: vi.fn(),
  strokeText: vi.fn(),
  measureText: vi.fn().mockReturnValue({ width: 50 }),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  rotate: vi.fn(),
  setLineDash: vi.fn(),
};

// ── Setup ────────────────────────────────────────────────────

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  
  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext);
  // Mock getBoundingClientRect for coordinate calculations
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    top: 0,
    width: 500,
    height: 500
  });

  const mockPage = {
    getViewport: vi.fn().mockReturnValue({ width: 500, height: 500 }),
    render: vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
  (pdfLoader.getCachedPageProxy as any).mockResolvedValue(mockPage);

  usePecoStore.setState({
    document: {
      filePath: 'test.pdf',
      pages: new Map([[0, {
        pageIndex: 0,
        textBlocks: [
          { id: 'b1', bbox: { x: 10, y: 10, width: 100, height: 50 }, text: 'Test', order: 0, pageIndex: 0 }
        ]
      }]])
    },
    zoom: 100,
    showOcr: true,
    ocrOpacity: 0.5,
    selectedIds: new Set(),
    isDrawingMode: false,
    isSplitMode: false,
  } as any);
});

describe('PdfCanvas', () => {
  it('should render canvas elements', async () => {
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const canvases = container.querySelectorAll('canvas');
    expect(canvases.length).toBe(2); // pdf layer and overlay layer
  });

  it('should select a block on click', async () => {
    // Wait for page to "load" (mocked promise)
    render(<PdfCanvas pageIndex={0} />);
    
    // Find overlay canvas
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const overlay = container.querySelectorAll('canvas')[1];

    // Click inside block b1 (10, 10, 100, 50)
    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 30 });
    
    // Check if store was updated
    const selectedIds = usePecoStore.getState().selectedIds;
    expect(selectedIds.has('b1')).toBe(true);
  });

  it('should enter drawing mode and allow drawing a new block', () => {
    usePecoStore.setState({ isDrawingMode: true } as any);
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const overlay = container.querySelectorAll('canvas')[1];

    // Start drawing at 200, 200
    fireEvent.mouseDown(overlay, { clientX: 200, clientY: 200 });
    // Move to 300, 300
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 300 });
    // Release
    fireEvent.mouseUp(overlay);

    // Check if a new block was added to the document
    const pageData = usePecoStore.getState().document?.pages.get(0);
    expect(pageData?.textBlocks.length).toBe(2);
    const newBlock = pageData?.textBlocks.find(b => (b as any).isNew);
    expect(newBlock).toBeDefined();
    expect(newBlock?.bbox.x).toBe(200);
    expect(newBlock?.bbox.y).toBe(200);
  });
});
