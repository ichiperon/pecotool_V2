import type * as pdfjsLib from 'pdfjs-dist';
import { BoundingBox } from '../types';

export interface PecoToolBBoxMetaEntry {
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
}

// プロトタイプ汚染攻撃を防ぐためのキー拒否リスト
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidBBox(value: unknown): value is BoundingBox {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height)
  );
}

function isValidEntry(value: unknown): value is PecoToolBBoxMetaEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (!isValidBBox(e.bbox)) return false;
  if (typeof e.writingMode !== 'string') return false;
  if (typeof e.text !== 'string') return false;
  if (!Number.isInteger(e.order) || (e.order as number) < 0) return false;
  return true;
}

function isValidBBoxMetaRecord(
  value: unknown,
): value is Record<string, PecoToolBBoxMetaEntry[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) return false;
    const arr = record[key];
    if (!Array.isArray(arr)) return false;
    for (const item of arr) {
      if (!isValidEntry(item)) return false;
    }
  }
  return true;
}

/**
 * Read PecoTool bbox metadata from the PDF if it was saved by this tool.
 * Returns null if no metadata found.
 */
export async function loadPecoToolBBoxMeta(
  pdf: pdfjsLib.PDFDocumentProxy,
): Promise<Record<string, PecoToolBBoxMetaEntry[]> | null> {
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as Record<string, unknown> | undefined;
    const custom = info?.Custom as Record<string, unknown> | undefined;
    // R4: `||` にして空文字列でも fallback する旧挙動を維持する
    const raw = custom?.PecoToolBBoxes || info?.PecoToolBBoxes;
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidBBoxMetaRecord(parsed)) {
        console.warn('[loadPecoToolBBoxMeta] Metadata schema validation failed');
        return null;
      }
      return parsed;
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  return null;
}
