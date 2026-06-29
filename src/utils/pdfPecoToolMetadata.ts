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

/** Catalog/PecoTool/BBoxes が指す PDFRawStream を取得する（無ければ null）。 */
function locatePrivateBBoxStream(pdfDoc: PDFDocument): PDFRawStream | null {
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
  return stream instanceof PDFRawStream ? stream : null;
}

function readPrivateBBoxMeta(pdfDoc: PDFDocument): Record<string, unknown> | null {
  const stream = locatePrivateBBoxStream(pdfDoc);
  if (!stream) return null;

  const decoded = decodeRawStream(stream);
  if (!decoded) return null;
  return parseBBoxMetaJson(new TextDecoder().decode(decoded));
}

/** 既存の private BBox stream が「存在するが decode/parse 不能」かを判定する。
 * true の場合、その stream は読めないだけで実データ（OCR BBox）を含む可能性があり、
 * 空メタで上書きすると恒久喪失する（#392 / PCT-161）。 */
function hasUnreadablePrivateBBoxStream(pdfDoc: PDFDocument): boolean {
  const stream = locatePrivateBBoxStream(pdfDoc);
  if (!stream) return false;
  const decoded = decodeRawStream(stream);
  if (!decoded) return true;
  return parseBBoxMetaJson(new TextDecoder().decode(decoded)) === null;
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

/** BBox メタの読み取り結果の分類。
 * - 'ok': private/legacy のいずれかから読めた（空オブジェクトを含む正常読取）。
 * - 'undecodable': private BBox stream は存在するが、本バージョンで decode/parse できない。
 *   → 読めないだけで実データ（OCR BBox）を含む可能性があり、上書きで恒久喪失しうる（#392）。
 * - 'empty': private/legacy のどちらも存在しない（メタ自体が無い）。 */
export type PecoToolBBoxMetaStatus = 'ok' | 'undecodable' | 'empty';

export interface PecoToolBBoxMetaRead {
  status: PecoToolBBoxMetaStatus;
  meta: Record<string, unknown>;
}

/** BBox メタを読取ステータス付きで返す（#392 / PCT-161）。
 * 'undecodable'（既存 stream はあるが読めない）を 'empty'（メタ無し）と区別することで、
 * 呼び出し側（保存パス）が「読めないだけで実在するデータ」を空・partial メタで破壊的に
 * 上書きしないよう判断できる。 */
export function readPecoToolBBoxMetaWithStatus(pdfDoc: PDFDocument): PecoToolBBoxMetaRead {
  const privateMeta = readPrivateBBoxMeta(pdfDoc);
  if (privateMeta) return { status: 'ok', meta: privateMeta };
  // legacy が読めるなら従来どおりそれを返す（旧 `private ?? legacy ?? {}` フォールバックを温存）。
  // undecodable は private が読めず legacy でも救えない場合に限る（= 真に読めない時だけ preserve）。
  const legacy = readLegacyInfoBBoxMeta(pdfDoc);
  if (legacy) return { status: 'ok', meta: legacy };
  if (hasUnreadablePrivateBBoxStream(pdfDoc)) return { status: 'undecodable', meta: {} };
  return { status: 'empty', meta: {} };
}

export function readPecoToolBBoxMetaFromPdfDoc(pdfDoc: PDFDocument): Record<string, unknown> {
  return readPecoToolBBoxMetaWithStatus(pdfDoc).meta;
}

export async function readPecoToolBBoxMetaWithStatusFromBytes(bytes: Uint8Array): Promise<PecoToolBBoxMetaRead> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(bytes), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  return readPecoToolBBoxMetaWithStatus(pdfDoc);
}

export async function readPecoToolBBoxMetaFromBytes(bytes: Uint8Array): Promise<Record<string, unknown>> {
  return (await readPecoToolBBoxMetaWithStatusFromBytes(bytes)).meta;
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
  // #392 / PCT-161: 新メタが空で、かつ既存に decode 不能な PecoTool BBox stream がある場合は
  // 上書きしない。読めないだけで実データ（OCR BBox）を含む可能性があり、空 {} で潰すと恒久喪失する。
  // 既存が decode 可能（= アプリも読めていた）状態での空保存は、ユーザーの全削除操作として尊重する。
  //
  // 層の役割（消さないこと）: 本体の保存パス（pdfSaverCore）は undecodable を read 境界で検出し
  // 原本バイトを完全 byte-preserve で返すため、通常はこの write 自体が呼ばれない。このガードは
  // pdfSaverCore を経由しない直接/別呼び出し元に対する last-line defense であり、partial メタは
  // 防げない（空のみ対象）。partial を含む完全防御は pdfSaverCore 側の byte-preserve が担う。
  if (Object.keys(bboxMeta).length === 0 && hasUnreadablePrivateBBoxStream(pdfDoc)) {
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
