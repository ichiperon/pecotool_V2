import { describe, it, expect } from 'vitest';
import { formatFileSize } from '../../utils/format';

describe('formatFileSize', () => {
  it('U-FT-01: 0 → "0 B"', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('U-FT-02: 512 → "512 B"', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('U-FT-03: 1024 → "1 KB"', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  it('U-FT-04: 1536 → "1.5 KB"', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('U-FT-05: 1048576 → "1 MB"', () => {
    expect(formatFileSize(1048576)).toBe('1 MB');
  });

  it('U-FT-06: 1572864 → "1.5 MB"', () => {
    expect(formatFileSize(1572864)).toBe('1.5 MB');
  });

  it('U-FT-07: 1073741824 → "1 GB"', () => {
    expect(formatFileSize(1073741824)).toBe('1 GB');
  });

  it('U-FT-08: 2684354560 → "2.5 GB"', () => {
    expect(formatFileSize(2684354560)).toBe('2.5 GB');
  });

  it('U-FT-09: 2048 → "2 KB" (no trailing zero)', () => {
    expect(formatFileSize(2048)).toBe('2 KB');
  });

  it('U-FT-10: 1 → "1 B"', () => {
    expect(formatFileSize(1)).toBe('1 B');
  });
});
