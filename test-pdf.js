import { PDFDocument } from 'pdf-lib';

async function main() {
  console.log("PDFDocument is", !!PDFDocument);
}
main().catch(console.error);
