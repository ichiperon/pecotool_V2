import type * as pdfjsLib from 'pdfjs-dist';
import { BoundingBox } from '../types';
import { readPecoToolBBoxMetaFromBytes } from './pdfPecoToolMetadata';

export interface PecoToolBBoxMetaEntry {
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
  /**
   * OCR 信頼度 (0..1)。#192 で追加。
   * 既存 PDF (confidence 欠如) との後方互換のため optional にする。
   */
  confidence?: number;
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
  // confidence は後方互換のため optional。存在する場合は 0..1 の有限数値であること。
  // Windows OCR は 0..1 を保証するため、範囲外（< 0 または > 1）はデータ破損とみなして弾く。
  if (
    e.confidence !== undefined &&
    (!Number.isFinite(e.confidence as number) ||
      (e.confidence as number) < 0 ||
      (e.confidence as number) > 1)
  ) return false;
  return true;
}

/**
 * Sanitize a raw parsed value into a validated bbox meta record.
 *
 * Instead of rejecting the entire record when any entry is invalid,
 * this function:
 *   - Returns null only when the top-level structure is fundamentally broken
 *     (non-object, null, or Array).
 *   - Skips DANGEROUS_KEYS (__proto__ / constructor / prototype) entirely
 *     (protects against prototype pollution; the page is dropped, not the whole record).
 *   - Skips keys whose value is not an Array.
 *   - Within each page array, keeps only entries that pass isValidEntry;
 *     invalid entries are silently discarded.
 *   - Returns a new record containing only valid entries.
 *     Pages that end up with zero valid entries are omitted from the result.
 */
function sanitizeBBoxMetaRecord(
  value: unknown,
): Record<string, PecoToolBBoxMetaEntry[]> | null {
  // Structural guard: non-object or null or array → completely broken, return null.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const result: Record<string, PecoToolBBoxMetaEntry[]> = {};

  for (const key of Object.keys(record)) {
    // DANGEROUS_KEYS: drop the key to prevent prototype pollution.
    // Other pages remain unaffected.
    if (DANGEROUS_KEYS.has(key)) continue;

    const arr = record[key];
    // Value must be an array; skip non-array page entries.
    if (!Array.isArray(arr)) continue;

    // Keep only valid entries; invalid ones are silently discarded.
    const validEntries = arr.filter((item): item is PecoToolBBoxMetaEntry =>
      isValidEntry(item),
    );

    // Omit pages that end up with zero valid entries
    // (avoids injecting empty arrays where callers don't expect them).
    if (validEntries.length > 0) {
      result[key] = validEntries;
    }
  }

  return result;
}

export interface PecoToolBBoxMetaSource {
  bytes?: Uint8Array;
  loadBytes?: () => Promise<Uint8Array | null | undefined>;
}

async function loadSourceBytes(
  source?: PecoToolBBoxMetaSource,
): Promise<Uint8Array | null> {
  if (!source) return null;
  if (source.bytes) return source.bytes;
  if (!source.loadBytes) return null;
  return (await source.loadBytes()) ?? null;
}

function validateParsedBBoxMeta(
  parsed: unknown,
): Record<string, PecoToolBBoxMetaEntry[]> | null {
  const sanitized = sanitizeBBoxMetaRecord(parsed);
  if (sanitized === null) {
    console.warn('[loadPecoToolBBoxMeta] Metadata schema validation failed: top-level structure is invalid');
    return null;
  }
  return sanitized;
}

/**
 * Read PecoTool bbox metadata from the PDF if it was saved by this tool.
 * Returns null if no metadata found.
 */
export async function loadPecoToolBBoxMeta(
  pdf: pdfjsLib.PDFDocumentProxy,
  source?: PecoToolBBoxMetaSource,
): Promise<Record<string, PecoToolBBoxMetaEntry[]> | null> {
  try {
    const bytes = await loadSourceBytes(source);
    if (bytes) {
      const parsed = await readPecoToolBBoxMetaFromBytes(bytes);
      if (Object.keys(parsed).length > 0) {
        return validateParsedBBoxMeta(parsed);
      }
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse private metadata stream:', err);
  }

  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as Record<string, unknown> | undefined;
    const custom = info?.Custom as Record<string, unknown> | undefined;
    // 修正 (#36): 旧 `||` は custom.PecoToolBBoxes が **非文字列** truthy 値
    // (例: 空オブジェクト {}, true, 数値) のときに info への fallback を skip し、
    // typeof チェックで弾かれて null を返してしまっていた。candidates を string
    // として明示的に length チェックしてから採用するように変える。
    const candidates: unknown[] = [custom?.PecoToolBBoxes, info?.PecoToolBBoxes];
    let raw: string | null = null;
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        raw = candidate;
        break;
      }
    }
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      return validateParsedBBoxMeta(parsed);
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  return null;
}
