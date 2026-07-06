/**
 * #357: renderMode 3 (invisible) 不可視性検証ヘルパー
 *
 * A-07 不変条件（各 TextBlock 末尾に invisible スペースが描画される）を
 * content stream レベルで厳密に検証するためのユーティリティ。
 *
 * 用途:
 *   - goldenMaster.test.ts の C01/C03 で A-07 の主張を実装で裏付ける
 *   - pdfSaverAcrobatWordBreak.test.ts / pdfSaverCurveGlyph.test.ts の
 *     `\b3\s+Tr\b` 単発マッチをより厳密な検証に置き換える
 *
 * 検証の核心:
 *   content stream（latin1 デコード済み文字列）の「Tj または TJ を含む各
 *   BT...ET セグメントすべて」に対して、「そのセグメント内で Tj/TJ より前に
 *   `3 Tr` が存在する」ことを確認する。
 *
 * ヘルパーは純粋関数（引数→戻り値）にして単体テストを容易にする。
 *
 * 前提（制約）: 文字列リテラル `(...) Tj` のオペランド内に空白区切りの
 * `BT`/`ET` トークンを含む content stream ではセグメント境界を誤認しうる。
 * 本ヘルパーの対象（自前 saver の生成した stream・hex 文字列主体）では
 * 発生しないが、外部 PDF 由来の stream に適用する場合は注意すること。
 */

/**
 * latin1 デコード済み content stream 文字列から BT...ET セグメントを全抽出する。
 *
 * @param stream - latin1 デコード済みの content stream 文字列
 * @returns BT...ET セグメントの文字列配列（BT/ET 自体は含む）
 */
export function extractBtEtSegments(stream: string): string[] {
  const segments: string[] = [];
  let pos = 0;
  while (pos < stream.length) {
    const btIdx = stream.indexOf('BT', pos);
    if (btIdx === -1) break;
    // BT が単語境界でなければスキップ（例: "ABT" 等）
    const beforeBt = btIdx === 0 ? ' ' : stream[btIdx - 1];
    if (!/[\s\r\n]/.test(beforeBt) && btIdx !== 0) {
      pos = btIdx + 1;
      continue;
    }
    const afterBt = stream[btIdx + 2];
    if (afterBt !== undefined && !/[\s\r\n]/.test(afterBt)) {
      pos = btIdx + 1;
      continue;
    }
    const etIdx = stream.indexOf('ET', btIdx + 2);
    if (etIdx === -1) break;
    // ET が単語境界でなければスキップ
    const afterEt = stream[etIdx + 2];
    if (afterEt !== undefined && !/[\s\r\n]/.test(afterEt)) {
      pos = etIdx + 1;
      continue;
    }
    segments.push(stream.slice(btIdx, etIdx + 2));
    pos = etIdx + 2;
  }
  return segments;
}

/**
 * 1 つの BT...ET セグメントに Tj または TJ 演算子が含まれるか判定する。
 *
 * @param segment - BT...ET セグメント文字列
 */
export function hasTjOrTJ(segment: string): boolean {
  return /\bTj\b/.test(segment) || /\bTJ\b/.test(segment);
}

/**
 * 1 つの BT...ET セグメントにおいて、最初の Tj/TJ 演算子より前に `3 Tr` が
 * 存在するか判定する。
 *
 * renderMode 3（invisible）は `3 Tr` という PDF オペレータで指定される。
 * Tr は通常テキスト開始部分（Tj/TJ より前）に書かれるため、このチェックは
 * 「描画前に invisible モードが設定されている」ことを意味する。
 *
 * @param segment - BT...ET セグメント文字列
 * @returns `3 Tr` が Tj/TJ より前に存在すれば true
 */
export function hasRenderMode3BeforeTj(segment: string): boolean {
  const trMatch = /\b3\s+Tr\b/.exec(segment);
  if (!trMatch) return false;
  const trPos = trMatch.index;

  // 最初の Tj または TJ の出現位置を探す
  const tjMatch = /\bTj\b/.exec(segment);
  const tjCapMatch = /\bTJ\b/.exec(segment);
  const firstTjPos = Math.min(
    tjMatch ? tjMatch.index : Infinity,
    tjCapMatch ? tjCapMatch.index : Infinity,
  );

  if (!Number.isFinite(firstTjPos)) return false;
  return trPos < firstTjPos;
}

/**
 * content stream（latin1 デコード済み）全体を検証する。
 *
 * 「Tj または TJ を含む各 BT...ET セグメントすべてに、そのセグメント内で
 * Tj/TJ より前に `3 Tr` が存在する」ことを確認する（#357 A-07 不変条件）。
 *
 * @param stream - latin1 デコード済みの content stream 文字列
 * @returns
 *   - `pass: true` — すべてのテキストセグメントが renderMode 3 の条件を満たす
 *   - `pass: false` — 条件を満たさないセグメントが存在する
 *   - `failingSegmentCount` — 条件を満たさないセグメント数
 *   - `totalTextSegments` — Tj/TJ を含む BT...ET セグメントの総数
 *   - `failingSegmentIndices` — 失敗したセグメントの0始まりインデックス
 */
export function assertAllTextSegmentsHaveRenderMode3(stream: string): {
  pass: boolean;
  failingSegmentCount: number;
  totalTextSegments: number;
  failingSegmentIndices: number[];
} {
  const segments = extractBtEtSegments(stream);
  const textSegments = segments.filter(hasTjOrTJ);
  const failingIndices: number[] = [];

  for (let i = 0; i < textSegments.length; i++) {
    if (!hasRenderMode3BeforeTj(textSegments[i])) {
      failingIndices.push(i);
    }
  }

  return {
    pass: failingIndices.length === 0,
    failingSegmentCount: failingIndices.length,
    totalTextSegments: textSegments.length,
    failingSegmentIndices: failingIndices,
  };
}
