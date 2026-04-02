import { PDFDocument, PDFName, PDFStream, PDFRawStream } from 'pdf-lib';
import fs from 'fs/promises';

async function main() {
  const libKeys = Object.keys(await import('pdf-lib'));
  console.log("decodePDFRawStream available?", libKeys.includes('decodePDFRawStream'));
}
main().catch(console.error);
