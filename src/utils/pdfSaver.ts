import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, translate, scale, PDFName, PDFHexString, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';

let cachedFontBytes: ArrayBuffer | null = null;

export async function savePDF(originalPdfBytes: Uint8Array, documentState: PecoDocument): Promise<Uint8Array> {
  // originalPdfBytes を確実にコピーして使用
  const pdfDoc = await PDFDocument.load(originalPdfBytes.slice());
  
  // カスタムフォントを登録して日本語テキストの不可視レイヤー埋め込みを有効にする
  pdfDoc.registerFontkit(fontkit);

  if (!cachedFontBytes) {
    try {
      const res = await fetch('/fonts/NotoSansJP-Regular.otf');
      if (res.ok) cachedFontBytes = await res.arrayBuffer();
    } catch(e) {
      console.warn('Failed to load font bytes', e);
    }
  }

  // フォントがある場合は日本語対応のNotoSansを埋め込み、ない場合は標準（英語のみ）をフォールバックとして使う
  // subset: true がデフォルトで有効なため、ファイルサイズの爆発は防がれる
  const customFont = cachedFontBytes 
    ? await pdfDoc.embedFont(cachedFontBytes, { subset: true }) 
    : await pdfDoc.embedFont(StandardFonts.Helvetica);

  let infoDict = (pdfDoc as any).getInfoDict();
  let existingBBoxMeta: Record<string, any> = {};

  if (infoDict) {
    try {
      const existingHex = infoDict.lookup(PDFName.of('PecoToolBBoxes'), PDFHexString);
      const existingStr = infoDict.lookup(PDFName.of('PecoToolBBoxes'), PDFString);
      if (existingHex) {
        existingBBoxMeta = JSON.parse(existingHex.decodeText());
      } else if (existingStr) {
        existingBBoxMeta = JSON.parse(existingStr.decodeText());
      }
    } catch(e) {
      console.warn('Failed to parse existing PecoToolBBoxes in savePDF', e);
    }
  }

  const bboxMeta: Record<string, any> = { ...existingBBoxMeta };

  for (const [pageIndex, pageData] of documentState.pages.entries()) {
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    // 常にすべてのページのBBメタデータを保存する（再読み込み時のズレ防止）
    bboxMeta[String(pageIndex)] = sortedBlocks.map(b => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text
    }));

    if (!pageData.isDirty) continue;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        // テキストを描画（透明なOCRレイヤーとして）
        if (block.writingMode === 'vertical') {
          const fontSize = 1;
          let textWidth = block.text.length;
          let textHeight = 1.448;
          try {
            textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
            textHeight = customFont.heightAtSize(fontSize) || textHeight;
          } catch(e) {}
          
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;
          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;
          
          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, {
            x: 0,
            y: 0,
            size: fontSize,
            font: customFont,
            rotate: degrees(-90),
            opacity: 0, // 不可視
          });
          page.pushOperators(popGraphicsState());
        } else {
          const fontSize = 1;
          let textWidth = block.text.length;
          let textHeight = 1.448;
          try {
            textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
            textHeight = customFont.heightAtSize(fontSize) || textHeight;
          } catch(e) {}
          
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          const baselineY = height - block.bbox.y - textHeight * sy * 0.8;
          
          page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
          page.drawText(block.text, {
            x: 0,
            y: 0,
            size: fontSize,
            font: customFont,
            opacity: 0, // 不可視
          });
          page.pushOperators(popGraphicsState());
        }
      } catch (err) {
        console.warn("Skipping block due to render error:", err);
      }
    }
  }

  // bbメタデータをInfoディクショナリに保存（再読み込み時にこのデータを元にBBを正確に復元する）
  if (!infoDict) {
    pdfDoc.setTitle(documentState.metadata?.title || 'OCR Document');
    infoDict = (pdfDoc as any).getInfoDict();
  }
  if (infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  // 互換性を最大化し、破損を防ぐオプションで保存
  return await pdfDoc.save({ 
    useObjectStreams: false, 
    addDefaultPage: false 
  });
}
