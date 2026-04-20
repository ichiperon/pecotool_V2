import { describe, it, expect, vi } from 'vitest';

// ── hoisted mocks ────────────────────────────────────────────────────────────
// pdfSaver.ts は @cantoo/pdf-lib / fontkit / pako をトップレベル import するため、
// stripTextBlocks 単独テストでも vi.mock で外部依存をスタブ化しておく。
vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument: { load: vi.fn() },
  StandardFonts: { Helvetica: 'Helvetica' },
  degrees: (n: number) => n,
  pushGraphicsState: vi.fn(),
  popGraphicsState: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  PDFName: Object.assign(function PDFName() {}, { of: vi.fn((s: string) => s) }),
  PDFHexString: { of: vi.fn(), fromText: vi.fn() },
  PDFString: { of: vi.fn(), fromText: vi.fn() },
  PDFRawStream: class {},
  PDFArray: class {},
  PDFDict: class {},
  PDFRef: class {},
  PDFObject: class {},
}));
vi.mock('@pdf-lib/fontkit', () => ({ default: {} }));
vi.mock('pako', () => ({ inflate: vi.fn() }));

import { stripTextBlocks } from '../../utils/pdfSaver';

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const dec = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

describe('stripTextBlocks — PDF string literal safety (repro)', () => {
  it('ケースA: 文字列内 " ET " を含む BT ブロックを正しく全削除する', () => {
    const input = enc('q\nBT /F1 12 Tf (Hello ET world) Tj ET\nQ');
    const output = dec(stripTextBlocks(input));
    // Tj が残っていれば BT...ET 外に漏れて Acrobat 7 で "Tj outside text object" が起きる
    expect(output).not.toContain('Tj');
    expect(output).not.toContain('BT');
    // 非テキスト演算子 q / Q は温存されるべき
    expect(output).toContain('q');
    expect(output).toContain('Q');
  });

  it('ケースB: ベースライン（文字列内に特殊トークンなし）— BT...ET を削除', () => {
    const input = enc('q\nBT /F1 12 Tf (foo) Tj ET\nq Q');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toContain('Tj');
    expect(output).not.toContain('BT');
    expect(output).not.toContain('ET');
  });

  it('ケースC: 文字列内 " BT " を含む — Tj が漏れないこと', () => {
    const input = enc('BT /F1 12 Tf (a) Tj (BT b) Tj ET');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toContain('Tj');
  });
});
