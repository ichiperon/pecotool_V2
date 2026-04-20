import { invoke } from '@tauri-apps/api/core';

export interface PageDimensions {
  width: number;
  height: number;
}

/**
 * Rust 側で PDF の MediaBox を直接パースして全ページの寸法を返す。
 * pdfjs の getViewport より 10 倍以上速いが、テキスト抽出や render には pdfjs が必要。
 * Tauri 以外の環境 (テスト等) では null を返しフォールバックを上位に委ねる。
 */
export async function getPdfPageDimensions(
  filePath: string,
): Promise<PageDimensions[] | null> {
  try {
    const raw = await invoke<Array<[number, number]>>('get_pdf_page_dimensions', {
      filePath,
    });
    return raw.map(([w, h]) => ({ width: w, height: h }));
  } catch (e) {
    console.warn(
      '[pdfFastMetadata] get_pdf_page_dimensions failed, fallback to pdfjs',
      e,
    );
    return null;
  }
}
