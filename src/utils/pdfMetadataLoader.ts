import type * as pdfjsLib from 'pdfjs-dist';
import { BoundingBox } from '../types';
import { readPecoToolBBoxMetaWithStatusFromBytes } from './pdfPecoToolMetadata';

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
  /**
   * 湾曲ベースライン定義 (issue #186)。構造は curveDefinition.ts の isCurveDefinition で
   * 検証してから TextBlock.curve へ取り込む。ここでは unknown のまま素通しし、
   * 妥当性検証は消費側 (pdfTextExtractor.ts の loadPage) に委ねる。
   */
  curve?: unknown;
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
  /**
   * PCT-103: メモ化用キー情報。
   * filePath + mtime の組み合わせをキャッシュキーとして使う。
   * mtime が undefined の場合はキャッシュをスキップ（安全側）。
   */
  filePath?: string;
  mtime?: number;
  /**
   * #392 / PCT-161: private BBox stream は存在するが本バージョンで decode/parse できない
   * （undecodable）と判定されたときに呼ばれる。呼び出し側は「このファイルの編集は保存に
   * 反映されない」旨を UI 警告で透明化するために使う。
   */
  onUndecodable?: () => void;
}

// PCT-103: 直近1ファイル分のメモ化エントリ。ファイル切替で自然に追い出される。
interface BBoxMetaCacheEntry {
  filePath: string;
  mtime: number;
  result: Record<string, PecoToolBBoxMetaEntry[]> | null;
  /** #392: private BBox stream が undecodable だったか。cache-hit でも onUndecodable を
   * 再通知するため保持する（onUndecodable 無しの先行ロードがキャッシュを充填しても、
   * 後続の onUndecodable 付き呼び出しで警告が確実に立つようにする）。 */
  undecodable: boolean;
}
let _bboxMetaCache: BBoxMetaCacheEntry | null = null;

/** PCT-103: テスト用キャッシュリセット。本番コードからは呼ばない。 */
export function _resetBBoxMetaCacheForTest(): void {
  _bboxMetaCache = null;
}

/**
 * PCT-103 / PCT-101: 上書き保存後に stale キャッシュが古いメタを返す退行を防ぐため、
 * 保存成功パスから呼ぶ本番用キャッシュ破棄。
 * destroySharedPdfProxy() と同じ「ディスク差し替え後の stale を明示破棄」の規約に参加する。
 */
export function invalidateBBoxMetaCache(): void {
  _bboxMetaCache = null;
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
 *
 * PCT-103: source.filePath + source.mtime が両方渡された場合は直近1エントリのメモ化を使用する。
 * mtime が渡されない場合はキャッシュをスキップし、毎回ロードする（安全側）。
 */
export async function loadPecoToolBBoxMeta(
  pdf: pdfjsLib.PDFDocumentProxy,
  source?: PecoToolBBoxMetaSource,
): Promise<Record<string, PecoToolBBoxMetaEntry[]> | null> {
  // PCT-103: キャッシュヒット確認。filePath と mtime が一致すれば即返す。
  const cacheFilePath = source?.filePath;
  const cacheMtime = source?.mtime;
  if (cacheFilePath !== undefined && cacheMtime !== undefined) {
    if (
      _bboxMetaCache !== null &&
      _bboxMetaCache.filePath === cacheFilePath &&
      _bboxMetaCache.mtime === cacheMtime
    ) {
      // #392: cache-hit でも undecodable は再通知する（先行の onUndecodable 無しロードが
      // キャッシュを充填しても、警告経路が確実に発火する）。
      if (_bboxMetaCache.undecodable) source?.onUndecodable?.();
      return _bboxMetaCache.result;
    }
  }

  let result: Record<string, PecoToolBBoxMetaEntry[]> | null = null;
  let undecodable = false;

  try {
    const bytes = await loadSourceBytes(source);
    if (bytes) {
      const read = await readPecoToolBBoxMetaWithStatusFromBytes(bytes);
      // #392: private stream はあるが decode 不能なら、保存パスは byte-preserve で編集を
      // 反映しない。ここで検出して呼び出し側に通知し、cache にも残して UI 警告で透明化する。
      if (read.status === 'undecodable') {
        undecodable = true;
        source?.onUndecodable?.();
      }
      const parsed = read.meta;
      if (Object.keys(parsed).length > 0) {
        result = validateParsedBBoxMeta(parsed);
        // PCT-103: キャッシュ更新
        if (cacheFilePath !== undefined && cacheMtime !== undefined) {
          _bboxMetaCache = { filePath: cacheFilePath, mtime: cacheMtime, result, undecodable };
        }
        return result;
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
      result = validateParsedBBoxMeta(parsed);
      // PCT-103: キャッシュ更新
      if (cacheFilePath !== undefined && cacheMtime !== undefined) {
        _bboxMetaCache = { filePath: cacheFilePath, mtime: cacheMtime, result, undecodable };
      }
      return result;
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  // PCT-103: null 結果もキャッシュする（メタなし PDF の繰り返し readFile を避ける）
  if (cacheFilePath !== undefined && cacheMtime !== undefined) {
    _bboxMetaCache = { filePath: cacheFilePath, mtime: cacheMtime, result: null, undecodable };
  }
  return null;
}
