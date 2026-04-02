import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
async function run() {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  
  doc.setTitle('Test');
  
  const meta = {
    test: '123_あいうえお'
  };
  
  const infoDict = doc.getInfoDict();
  if (infoDict) {
     infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(meta)));
  }
  
  const bytes = await doc.save();
  
  const doc2 = await PDFDocument.load(bytes);
  console.log('Title:', doc2.getTitle());
  const info = doc2.getInfoDict();
  if (!info) return console.log('No info');
  
  const anyObj = info.get(PDFName.of('PecoToolBBoxes'));
  console.log('Raw type:', anyObj?.constructor.name);
  if (anyObj instanceof PDFHexString || anyObj instanceof PDFString) {
     console.log('Decoded:', anyObj.decodeText());
  }
}
run();
