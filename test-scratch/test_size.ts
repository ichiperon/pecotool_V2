import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as fs from 'fs';

async function run() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 500]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  
  let str = "あいうえお漢字";
  for(let i=0; i<100; i++) str += "テスト" + i;
  
  try {
     page.drawText(str, { font: font });
  } catch(e) {
     console.error('error drawing text:', e.message);
  }
  
  const bytes = await doc.save();
  fs.writeFileSync('test_size.pdf', bytes);
  console.log('Size:', bytes.length);
}
run();
