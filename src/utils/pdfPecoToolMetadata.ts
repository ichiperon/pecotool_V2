import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  type PDFDict,
} from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { safeDecodePdfText } from './pdfLibSafeDecode';

const PECO_TOOL_KEY = PDFName.of('PecoTool');
const PECO_TOOL_BBOXES_KEY = PDFName.of('BBoxes');
const LEGACY_INFO_BBOXES_KEY = PDFName.of('PecoToolBBoxes');
const BINARY_STRING_CHUNK_SIZE = 0x8000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBBoxMetaJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function encodeUtf8BinaryString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let result = '';
  for (let i = 0; i < bytes.length; i += BINARY_STRING_CHUNK_SIZE) {
    let chunk = '';
    const end = Math.min(i + BINARY_STRING_CHUNK_SIZE, bytes.length);
    for (let j = i; j < end; j += 1) {
      chunk += String.fromCharCode(bytes[j]);
    }
    result += chunk;
  }
  return result;
}

function decodePdfStringValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const textValue = value as {
    decodeText?: () => string;
    asString?: () => string;
  };
  try {
    if (typeof textValue.decodeText === 'function') {
      return safeDecodePdfText(value as Parameters<typeof safeDecodePdfText>[0]);
    }
  } catch {
    try {
      return textValue.decodeText?.() ?? null;
    } catch {
      // Fall through to asString below.
    }
  }
  try {
    return typeof textValue.asString === 'function' ? textValue.asString() : null;
  } catch {
    return null;
  }
}

/** PDF の /Filter を単一フィルタ名へ正規化する。
 * 単一名 (/FlateDecode) と、外部ツールが正規化しがちな配列形式 ([/FlateDecode]) の
 * 両方を扱う。複数フィルタチェーン ([... /FlateDecode] 等) は inflate 単体で復号
 * できないため null を返す（呼び出し側で未対応として扱う）。
 */
function resolveFilterName(filter: unknown): string | null {
  if (!filter) return null;

  const asName = (f: unknown): string | null => {
    const like = f as { asString?: () => string } | undefined;
    if (typeof like?.asString === 'function') return like.asString();
    return typeof f === 'string' ? f : null;
  };

  // 配列形式 [/FlateDecode]（Acrobat 等の最適化で単一 /Filter が配列化される）
  const arrLike = filter as { asArray?: () => unknown[] } | undefined;
  if (typeof arrLike?.asArray === 'function') {
    const elems = arrLike.asArray();
    return elems.length === 1 ? asName(elems[0]) : null;
  }

  return asName(filter);
}

function decodeRawStream(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();
  const filterName = resolveFilterName(filter);

  if (filterName === '/FlateDecode' || filterName === 'FlateDecode') {
    try {
      return inflate(raw);
    } catch {
      return null;
    }
  }
  if (!filter) return raw;
  return null;
}

function readPrivateBBoxMeta(pdfDoc: PDFDocument): Record<string, unknown> | null {
  const catalog = pdfDoc.catalog as unknown as {
    get?: (key: PDFName) => unknown;
  } | undefined;
  const pecoToolValue = catalog?.get?.(PECO_TOOL_KEY);
  if (!pecoToolValue) return null;

  const pecoToolDict = pdfDoc.context.lookup(pecoToolValue as never) as {
    get?: (key: PDFName) => unknown;
  } | undefined;
  const bboxesValue = pecoToolDict?.get?.(PECO_TOOL_BBOXES_KEY);
  if (!bboxesValue) return null;

  const stream = pdfDoc.context.lookup(bboxesValue as never);
  if (!(stream instanceof PDFRawStream)) return null;

  const decoded = decodeRawStream(stream);
  if (!decoded) return null;
  return parseBBoxMetaJson(new TextDecoder().decode(decoded));
}

function getInfoDictSafe(pdfDoc: PDFDocument): PDFDict | undefined {
  // getInfoDict() のシグネチャは PDFDict | undefined だが、unit test 等で渡される
  // モック PDFDocument が `get`/`delete` を欠いた粗い辞書 ({ lookup, set }) を返す
  // ことがある。本物の PDFDict は `get` メソッドを持つので、ダックタイピングで
  // 安全側にフォールバックする (instanceof PDFDict はモジュールモック環境では使えない)。
  const infoDict = (pdfDoc as unknown as { getInfoDict?: () => unknown }).getInfoDict?.();
  if (!infoDict || typeof infoDict !== 'object') return undefined;
  if (typeof (infoDict as { get?: unknown }).get !== 'function') return undefined;
  return infoDict as PDFDict;
}

function readLegacyInfoBBoxMeta(pdfDoc: PDFDocument): Record<string, unknown> | null {
  const infoDict = getInfoDictSafe(pdfDoc);
  const value = infoDict?.get(LEGACY_INFO_BBOXES_KEY);
  const decoded = decodePdfStringValue(value);
  return decoded ? parseBBoxMetaJson(decoded) : null;
}

export function readPecoToolBBoxMetaFromPdfDoc(pdfDoc: PDFDocument): Record<string, unknown> {
  return readPrivateBBoxMeta(pdfDoc) ?? readLegacyInfoBBoxMeta(pdfDoc) ?? {};
}

export async function readPecoToolBBoxMetaFromBytes(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(bytes), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  return readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
}

export function removeLegacyPecoToolBBoxInfo(pdfDoc: PDFDocument): void {
  const infoDict = getInfoDictSafe(pdfDoc);
  (infoDict as unknown as { delete?: (key: PDFName) => void } | undefined)?.delete?.(LEGACY_INFO_BBOXES_KEY);
}

export function hasLegacyPecoToolBBoxInfo(pdfDoc: PDFDocument): boolean {
  const infoDict = getInfoDictSafe(pdfDoc);
  return infoDict?.get(LEGACY_INFO_BBOXES_KEY) != null;
}

export function writePecoToolBBoxMetaToPdfDoc(
  pdfDoc: PDFDocument,
  bboxMeta: Record<string, unknown>,
): void {
  // unit test 等の粗い PDFDocument モックでは context.flateStream / catalog.set が
  // 揃っていないことがある。本物の pdf-lib では常に揃っているので、ガードに
  // ヒットするのはモック経路のみ。実コード経路でメタを書き損ねることはない。
  const context = pdfDoc.context as unknown as {
    flateStream?: (...args: unknown[]) => unknown;
    register?: (...args: unknown[]) => unknown;
    obj?: (...args: unknown[]) => unknown;
  } | undefined;
  const catalog = pdfDoc.catalog as unknown as {
    set?: (key: PDFName, value: unknown) => void;
  } | undefined;
  if (
    !context ||
    typeof context.flateStream !== 'function' ||
    typeof context.register !== 'function' ||
    typeof context.obj !== 'function' ||
    typeof catalog?.set !== 'function'
  ) {
    return;
  }
  const json = JSON.stringify(bboxMeta);
  const streamRef = context.register(context.flateStream(encodeUtf8BinaryString(json), {
    Type: 'PecoToolData',
    Subtype: 'BBoxes',
    Version: 1,
  }));
  const pecoToolDict = context.obj({
    Version: 1,
    BBoxes: streamRef,
  });
  catalog.set(PECO_TOOL_KEY, pecoToolDict as never);
  removeLegacyPecoToolBBoxInfo(pdfDoc);
}
