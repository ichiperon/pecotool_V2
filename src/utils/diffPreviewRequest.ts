import type { SaveDiffSummary } from './saveDiffSummary';

/**
 * PCT-075: 保存前 diff プレビュー要求の resolver 管理。
 *
 * App.tsx は useFileOperations の onRequestDiffPreview に本関数を配線する。
 * resolverRef.current には「プレビューの確定/キャンセルを handleSave へ返す resolve」
 * が保持され、DiffPreviewModal の onConfirm / onCancel がそれを呼ぶ。
 *
 * 旧実装は resolverRef.current を無条件に上書きしていたため、プレビュー表示中に
 * もう一度保存要求が来る (モーダルは Esc/Tab しか捕捉せず Ctrl+S が window
 * リスナーへ素通りする) と、1 本目の handleSave が await している Promise の
 * resolver が失われて永久 pending になっていた (ゾンビ Promise)。
 *
 * 本関数は未解決の旧 resolver が残っている場合、resolve(false) でキャンセル扱いに
 * してから新しい resolver へ差し替える。旧 handleSave は「ユーザーがキャンセルした」
 * 場合と同じ経路で静かに終了し、最新の要求だけがモーダルに残る。
 */
export interface DiffPreviewResolverRef {
  current: ((confirmed: boolean) => void) | null;
}

export function requestDiffPreview(
  resolverRef: DiffPreviewResolverRef,
  showSummary: (summary: SaveDiffSummary) => void,
  summary: SaveDiffSummary,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    showSummary(summary);
  });
}
