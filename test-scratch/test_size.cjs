const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('fs');

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
  
  const bytes = await doc.save({ useObjectStreams: false });
  fs.writeFileSync('test_size.pdf', bytes);
  console.log('Size without stream:', bytes.length);

  const bytes2 = await doc.save({ useObjectStreams: true });
  fs.writeFileSync('test_size2.pdf', bytes2);
  console.log('Size with stream:', bytes2.length);
}
run();
