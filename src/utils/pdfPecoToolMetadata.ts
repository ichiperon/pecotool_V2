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

function decodeRawStream(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();
  const filterLike = filter as unknown as { asString?: () => string } | undefined;
  const filterName = typeof filterLike?.asString === 'function'
    ? filterLike.asString()
    : typeof filter === 'string'
      ? filter
      : null;

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
  };
  const pecoToolValue = catalog.get?.(PECO_TOOL_KEY);
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

function readLegacyInfoBBoxMeta(pdfDoc: PDFDocument): Record<string, unknown> | null {
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
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
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  (infoDict as unknown as { delete?: (key: PDFName) => void } | undefined)?.delete?.(LEGACY_INFO_BBOXES_KEY);
}

export function hasLegacyPecoToolBBoxInfo(pdfDoc: PDFDocument): boolean {
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  return infoDict?.get(LEGACY_INFO_BBOXES_KEY) != null;
}

export function writePecoToolBBoxMetaToPdfDoc(
  pdfDoc: PDFDocument,
  bboxMeta: Record<string, unknown>,
): void {
  const json = JSON.stringify(bboxMeta);
  const streamRef = pdfDoc.context.register(pdfDoc.context.flateStream(encodeUtf8BinaryString(json), {
    Type: 'PecoToolData',
    Subtype: 'BBoxes',
    Version: 1,
  }));
  const pecoToolDict = pdfDoc.context.obj({
    Version: 1,
    BBoxes: streamRef,
  });
  pdfDoc.catalog.set(PECO_TOOL_KEY, pecoToolDict);
  removeLegacyPecoToolBBoxInfo(pdfDoc);
}
