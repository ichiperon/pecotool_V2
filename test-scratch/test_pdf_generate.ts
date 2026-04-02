import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import * as fs from 'fs';

async function run() {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  doc.setTitle('Test');
  
  const meta = {
    "0": [{ bbox: {x:1,y:2,width:3,height:4}, writingMode: "horizontal", order: 0, text: "テスト" }]
  };
  
  const infoDict = doc.getInfoDict();
  if (infoDict) {
     infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(meta)));
  }
  
  const bytes = await doc.save();
  fs.writeFileSync('test_pdf.pdf', bytes);
}
run();
