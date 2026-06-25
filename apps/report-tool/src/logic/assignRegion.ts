import type { BoundingBox, ReportBlock, ReportField } from "../types/report";

/**
 * 2 つの矩形の重なり面積を計算する。
 * 重なりがなければ 0 を返す。
 */
function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  const w = right - left;
  const h = bottom - top;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * bbox の中心点が含まれるフィールドを返す。
 * 複数の field に中心が含まれる場合は bbox との重なり面積が最大のものを選択する。
 * どの field にも含まれなければ null を返す。
 *
 * @param bbox     判定対象のバウンディングボックス
 * @param fields   テンプレートフィールド一覧
 */
export function assignRegionByCoord(
  bbox: BoundingBox,
  fields: ReportField[]
): string | null {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;

  const candidates = fields.filter(
    (f) =>
      cx >= f.rect.x &&
      cx <= f.rect.x + f.rect.width &&
      cy >= f.rect.y &&
      cy <= f.rect.y + f.rect.height
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  // 重なり面積が最大のフィールドを選択する
  let bestId = candidates[0].id;
  let bestArea = overlapArea(bbox, candidates[0].rect);

  for (let i = 1; i < candidates.length; i++) {
    const area = overlapArea(bbox, candidates[i].rect);
    if (area > bestArea) {
      bestArea = area;
      bestId = candidates[i].id;
    }
  }

  return bestId;
}

export interface AssignBlocksOptions {
  /**
   * isManual=true のブロックの fieldId を座標で再判定するか。
   * false（既定）の場合、手入力ブロックの既存 fieldId を尊重する。
   */
  reAssignManual?: boolean;
}

/**
 * 各 block に fieldId を付与して返す。
 * 元の block 配列は変更しない（イミュータブル）。
 *
 * @param blocks  入力ブロック群
 * @param fields  テンプレートフィールド一覧
 * @param opts    オプション
 */
export function assignBlocksToFields(
  blocks: ReportBlock[],
  fields: ReportField[],
  opts: AssignBlocksOptions = {}
): ReportBlock[] {
  const { reAssignManual = false } = opts;

  return blocks.map((block) => {
    // 手入力ブロックで既存 fieldId がある場合の扱い
    if (block.isManual && !reAssignManual && block.fieldId !== null) {
      return block;
    }

    const fieldId = assignRegionByCoord(block.bbox, fields);
    return { ...block, fieldId };
  });
}
