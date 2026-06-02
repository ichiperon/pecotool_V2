// See: GitHub Issue #96 — Fix 3: 到達可能性ベース GC
//
// pdf-lib の `PDFDocument.load()` は xref 全オブジェクトを `context.indirectObjects`
// に読み、`pdfDoc.save()` はその全件を書き出す（参照グラフ未追跡）。本ツールが
// 過去に保存した PDF には /Root から到達不能な孤児コンテンツストリームが大量に
// 残っているため、再保存のたびにファイルが膨れる。本モジュールは save() 直前に
// /Root を起点に BFS で indirect object を辿り、到達不能オブジェクトを
// `context.delete(ref)` する。
import {
  PDFArray,
  PDFDict,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib';

export interface SweepResult {
  /** 削除した indirect object 数 */
  dropped: number;
}

export interface CompactResult {
  /** object number が変更された indirect object 数 */
  renumbered: number;
}

// PDFRef を数値キーに変換するための倍率。generationNumber は PDF 仕様上
// 0〜65535 の範囲を取りうるが、実運用では数十までしか観測されない。
// それでも安全側に倒し 1e6 を倍率とする (objectNumber * 1_000_000 + gen)。
// JS の Number は 2^53 - 1 まで安全に整数を扱えるため、約 9e15 / 1e6 = 9e9 個の
// オブジェクトまで衝突しない。実 PDF の indirect object 数は最大でも数百万なので
// 衝突は発生しない。
const REF_KEY_MULTIPLIER = 1_000_000;
const refKey = (ref: PDFRef): number =>
  ref.objectNumber * REF_KEY_MULTIPLIER + ref.generationNumber;

function isTraversableObject(value: PDFObject): value is PDFRef | PDFDict | PDFArray | PDFStream {
  return value instanceof PDFRef || value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream;
}

/**
 * /Root を起点に BFS で到達可能な indirect object 集合を求め、
 * それ以外を pdfDoc.context.delete() で削除する。
 *
 * 用途:
 * - 既に膨れたPDF（過去の保存で孤児が温存されている）を本ツールで再保存するとき、
 *   孤児を全て掃除して原本サイズ級に収束させる（issue #96 要件2）
 * - 通常の OCR 校正保存でも、誤って参照を切られたオブジェクトを次回保存で確実に除去する
 *   防衛線として動作する
 *
 * 起点:
 * - trailerInfo.Root（必須。Catalog 経由で Pages, AcroForm, Outlines, Metadata,
 *   StructTreeRoot, MarkInfo, OutputIntents 等が全て辿れる）
 * - trailerInfo.Info（文書情報辞書。旧PecoToolBBoxesメタを持つ既存PDFもある）
 * - trailerInfo.Encrypt（encrypted PDF の場合）
 * - trailerInfo.ID（通常は 2 つの string 直値だが、indirect ref 経由のケースで
 *   参照不能になることを防ぐため起点化）
 */
export function sweepUnreachableObjects(pdfDoc: PDFDocument): SweepResult {
  const context = pdfDoc.context;
  // PDFRef ベースの到達可能集合。文字列 toString() を避け、数値キーで管理する
  // ことで大規模 PDF の数十万回呼び出しによるオーバーヘッドを削減する。
  const reachable = new Set<number>();
  const visitedObjects = new WeakSet<object>();
  const queue: PDFObject[] = [];

  const enqueue = (obj: PDFObject | undefined | null): void => {
    if (!obj) return;
    queue.push(obj);
  };

  // PDFContext.trailerInfo の型は実装上 { Root?, Info?, Encrypt?, ID? } だが
  // 公開型では index signature を持たないため構造型アサーションを介してアクセスする。
  const trailerInfo = (context as unknown as {
    trailerInfo?: {
      Root?: PDFObject;
      Info?: PDFObject;
      Encrypt?: PDFObject;
      ID?: PDFObject;
    };
  }).trailerInfo;
  if (!trailerInfo?.Root || typeof (context as unknown as { enumerateIndirectObjects?: unknown }).enumerateIndirectObjects !== 'function') {
    return { dropped: 0 };
  }

  enqueue(trailerInfo.Root);
  enqueue(trailerInfo.Info);
  enqueue(trailerInfo.Encrypt);
  enqueue(trailerInfo.ID);

  while (queue.length > 0) {
    const obj = queue.pop()!;
    if (obj instanceof PDFRef) {
      const key = refKey(obj);
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(obj);
      if (target) enqueue(target);
      continue;
    }
    if (obj instanceof PDFStream) {
      if (visitedObjects.has(obj)) continue;
      visitedObjects.add(obj);
      // stream dict を辿る（PDFStream は PDFDict ではないので別ブランチ）
      for (const [, value] of obj.dict.entries()) {
        if (isTraversableObject(value)) {
          enqueue(value);
        }
      }
      continue;
    }
    if (obj instanceof PDFDict) {
      if (visitedObjects.has(obj)) continue;
      visitedObjects.add(obj);
      for (const [, value] of obj.entries()) {
        if (isTraversableObject(value)) {
          enqueue(value);
        }
      }
      continue;
    }
    if (obj instanceof PDFArray) {
      if (visitedObjects.has(obj)) continue;
      visitedObjects.add(obj);
      for (const value of obj.asArray()) {
        if (isTraversableObject(value)) {
          enqueue(value);
        }
      }
      continue;
    }
    // それ以外（PDFName / PDFString / PDFNumber 等）は辺を持たないので無視
  }

  let dropped = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (reachable.has(refKey(ref))) continue;
    // bytesFreed の集計は廃止: getContents() は pdf-lib 内部で inflate を走らせる
    // 可能性があり、捨てる予定のオブジェクトを decompress するのは無駄。また
    // 集計値は圧縮済みバイト・xref オーバーヘッド非考慮でミスリーディングだった。
    context.delete(ref);
    dropped++;
  }
  return { dropped };
}

function remapRef(refMap: Map<string, PDFRef>, value: PDFObject | undefined): PDFObject | undefined {
  if (value instanceof PDFRef) {
    return refMap.get(value.toString()) ?? value;
  }
  return value;
}

function rewriteRefsInObject(obj: PDFObject, refMap: Map<string, PDFRef>, seen: WeakSet<object>): void {
  if (obj instanceof PDFRef) return;
  if (!(obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFStream)) return;
  if (seen.has(obj)) return;
  seen.add(obj);

  if (obj instanceof PDFStream) {
    rewriteRefsInObject(obj.dict, refMap, seen);
    return;
  }

  if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) {
      const mapped = remapRef(refMap, value);
      if (mapped && mapped !== value) obj.set(key, mapped);
      rewriteRefsInObject(mapped ?? value, refMap, seen);
    }
    return;
  }

  for (let i = 0; i < obj.size(); i++) {
    const value = obj.get(i);
    const mapped = remapRef(refMap, value);
    if (mapped && mapped !== value) obj.set(i, mapped);
    rewriteRefsInObject(mapped ?? value, refMap, seen);
  }
}

export function compactIndirectObjectNumbers(pdfDoc: PDFDocument): CompactResult {
  const context = pdfDoc.context as unknown as {
    indirectObjects?: Map<PDFRef, PDFObject>;
    largestObjectNumber: number;
    enumerateIndirectObjects: () => Array<[PDFRef, PDFObject]>;
    assign: (ref: PDFRef, object: PDFObject) => void;
    trailerInfo?: Record<string, PDFObject | undefined>;
  };
  const indirectObjects = context.indirectObjects;
  if (!(indirectObjects instanceof Map)) return { renumbered: 0 };

  const entries = context.enumerateIndirectObjects();
  if (entries.length === 0) return { renumbered: 0 };

  // 早期 return 強化: object 番号が既に dense (1..N かつ generation 0) で
  // largestObjectNumber も entries.length と一致するなら refMap も rewrite も
  // 不要。entries 走査を 1 周するだけで判定でき、その後の indirectObjects.clear()
  // / 再 assign / rewriteRefsInObject の重い処理を全てスキップできる。
  let alreadyDense = context.largestObjectNumber === entries.length;
  if (alreadyDense) {
    for (let i = 0; i < entries.length; i++) {
      const ref = entries[i][0];
      if (ref.objectNumber !== i + 1 || ref.generationNumber !== 0) {
        alreadyDense = false;
        break;
      }
    }
  }
  if (alreadyDense) {
    return { renumbered: 0 };
  }

  const refMap = new Map<string, PDFRef>();
  let renumbered = 0;
  entries.forEach(([oldRef], index) => {
    const newRef = PDFRef.of(index + 1, 0);
    refMap.set(oldRef.toString(), newRef);
    if (newRef !== oldRef) renumbered += 1;
  });
  if (renumbered === 0 && context.largestObjectNumber === entries.length) {
    return { renumbered: 0 };
  }

  const seen = new WeakSet<object>();
  for (const [, object] of entries) {
    rewriteRefsInObject(object, refMap, seen);
  }

  const trailerInfo = context.trailerInfo;
  if (trailerInfo) {
    const trailerSeen = new WeakSet<object>();
    for (const key of Object.keys(trailerInfo)) {
      const mapped = remapRef(refMap, trailerInfo[key]);
      trailerInfo[key] = mapped;
      if (mapped) rewriteRefsInObject(mapped, refMap, trailerSeen);
    }
  }

  indirectObjects.clear();
  context.largestObjectNumber = 0;
  entries.forEach(([, object], index) => {
    context.assign(PDFRef.of(index + 1, 0), remapRef(refMap, object) ?? object);
  });

  return { renumbered };
}
