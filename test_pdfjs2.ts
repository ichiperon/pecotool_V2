import * as fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist';

async function run() {
  const bytes = fs.readFileSync('test_pdf.pdf');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await loadingTask.promise;
  const metadata = await pdf.getMetadata();
  console.log(metadata.info);
}
run();
