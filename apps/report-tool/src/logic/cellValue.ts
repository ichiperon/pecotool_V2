import type { ReportBlock } from "../types/report";

/**
 * 同一フィールドに属するブロック群から信頼度を決める。
 *
 * confidence を持つブロックの最小値を返す（保守的: 1 つでも低ければ低扱い）。
 * confidence 付きブロックが 1 件も無い場合は undefined を返す。
 *
 * @param blocks 同一フィールドのブロック群
 */
export function decideCellConfidence(blocks: ReportBlock[]): number | undefined {
  let min: number | undefined = undefined;
  for (const b of blocks) {
    if (b.confidence !== undefined) {
      min = min === undefined ? b.confidence : Math.min(min, b.confidence);
    }
  }
  return min;
}

export interface CellValueOptions {
  /**
   * y 座標の差がこの値以内ならば「同一行」と見なす閾値（ピクセル相当）。
   * 既定: 8
   */
  lineThreshold?: number;
  /**
   * 同一フィールドのブロック間を繋げる文字列。
   * 既定: "" （直結）
   */
  joiner?: string;
}

/**
 * 同一フィールドに属するブロック群から 1 つのセル値を決める。
 *
 * 処理手順:
 * 1. text が空文字・空白のみのブロックを除外する（全角空白を含む）
 * 2. 読み順ソート: y 昇順、同一帯（|y差| <= lineThreshold）内は x 昇順
 * 3. joiner で連結する
 * 0 件の場合は空文字を返す。
 *
 * @param blocks  同一フィールドのブロック群
 * @param opts    オプション
 */
export function decideCellValue(
  blocks: ReportBlock[],
  opts: CellValueOptions = {}
): string {
  const { lineThreshold = 8, joiner = "" } = opts;

  // 空文字・空白（全角空白含む）のみのブロックを除外する
  const nonEmpty = blocks.filter((b) => b.text.replace(/[\s　]+/g, "") !== "");

  if (nonEmpty.length === 0) return "";

  // 読み順ソート: y 昇順 → 同帯内は x 昇順
  const sorted = [...nonEmpty].sort((blockA, blockB) => {
    const ay = blockA.bbox.y;
    const by = blockB.bbox.y;
    const ax = blockA.bbox.x;
    const bx = blockB.bbox.x;

    if (Math.abs(ay - by) <= lineThreshold) {
      // 同一行と見なす → x 昇順
      return ax - bx;
    }
    return ay - by;
  });

  return sorted.map((b) => b.text).join(joiner);
}

/**
 * 同一フィールドに属するブロック群を y 座標でクラスタリングし、段（行）ごとの
 * 文字列に分割する。明細欄（isLineItem）で複数行の品名等を 1 段 1 値として
 * 扱うために使う。
 *
 * 処理手順:
 * 1. decideCellValue と同じ規則で空文字・空白のみ（全角空白含む）のブロックを除外する
 * 2. y 昇順にソートする
 * 3. 直前に採用したブロックとの y 差が lineThreshold 以内なら同一段とみなして束ね、
 *    超えたら新しい段を開始する（隣接ブロックの連鎖でクラスタを作る）
 * 4. 各段（クラスタ）内のテキスト連結は decideCellValue に委譲する
 *    （同一段内の x 昇順ソート・joiner 適用も decideCellValue と同じ規則になる）
 *
 * ブロックが 0 件（除外後も含む）の場合は空配列を返す。
 *
 * @param blocks 同一フィールドのブロック群
 * @param opts   オプション（lineThreshold は段分割の閾値、joiner は段内連結に使う）
 */
export function clusterBlocksToRows(
  blocks: ReportBlock[],
  opts: CellValueOptions = {}
): string[] {
  const { lineThreshold = 8 } = opts;

  const nonEmpty = blocks.filter((b) => b.text.replace(/[\s　]+/g, "") !== "");
  if (nonEmpty.length === 0) return [];

  const sorted = [...nonEmpty].sort((blockA, blockB) => blockA.bbox.y - blockB.bbox.y);

  const clusters: ReportBlock[][] = [];
  let current: ReportBlock[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const block = sorted[i];
    const prev = current[current.length - 1];
    if (Math.abs(block.bbox.y - prev.bbox.y) <= lineThreshold) {
      current.push(block);
    } else {
      clusters.push(current);
      current = [block];
    }
  }
  clusters.push(current);

  return clusters.map((cluster) => decideCellValue(cluster, opts));
}
