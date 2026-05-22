const STARTXREF_TAIL_BYTES = 4096;
const FREE_XREF_ENTRY = '0000000000 65535 f ';

function asciiFromBytes(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  const chunkSize = 8192;
  for (let i = start; i < end; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, end);
    for (let j = i; j < chunkEnd; j++) {
      out += String.fromCharCode(bytes[j]);
    }
  }
  return out;
}

function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function findStartXrefOffset(pdfBytes: Uint8Array): number | null {
  const tailStart = Math.max(0, pdfBytes.length - STARTXREF_TAIL_BYTES);
  const tail = asciiFromBytes(pdfBytes, tailStart, pdfBytes.length);
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!match) return null;

  const offset = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= pdfBytes.length) {
    return null;
  }
  return offset;
}

function parseXrefEntries(xrefText: string): Map<number, string> | null {
  const entries = new Map<number, string>();
  const lines = xrefText.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i].trim();
    i += 1;
    if (!headerLine) continue;

    const header = /^(\d+)\s+(\d+)$/.exec(headerLine);
    if (!header) return null;

    const first = Number.parseInt(header[1], 10);
    const count = Number.parseInt(header[2], 10);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 0) {
      return null;
    }

    for (let j = 0; j < count; j++) {
      if (i >= lines.length) return null;
      const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(lines[i].trimEnd());
      if (!entry) return null;
      entries.set(first + j, `${entry[1]} ${entry[2]} ${entry[3]} `);
      i += 1;
    }
  }

  return entries;
}

function isInUseEntry(entry: string): boolean {
  return /\sn\s*$/.test(entry);
}

/**
 * pdf-lib can emit sparse classic xref tables after unreachable objects are
 * deleted (for example, "0 6" and "9 10" with missing entries 6-8). Modern
 * readers tolerate that, but Acrobat 7 repairs the xref on open and then shows
 * a save prompt on close. Rebuild the final xref as one dense subsection and
 * mark missing object numbers as free entries.
 */
export function ensureDenseClassicXref(pdfBytes: Uint8Array): Uint8Array {
  const xrefStart = findStartXrefOffset(pdfBytes);
  if (xrefStart === null) return pdfBytes;

  const tail = asciiFromBytes(pdfBytes, xrefStart, pdfBytes.length);
  if (!tail.startsWith('xref')) return pdfBytes;

  const trailerIndex = tail.search(/\btrailer\b/);
  if (trailerIndex < 0) return pdfBytes;

  const startxrefIndex = tail.indexOf('startxref', trailerIndex);
  if (startxrefIndex < 0) return pdfBytes;

  const xrefBody = tail.slice('xref'.length, trailerIndex).trim();
  const trailerDict = tail.slice(trailerIndex + 'trailer'.length, startxrefIndex).trim();
  const sizeMatch = /\/Size\s+(\d+)/.exec(trailerDict);
  if (!sizeMatch) return pdfBytes;

  const size = Number.parseInt(sizeMatch[1], 10);
  if (!Number.isSafeInteger(size) || size <= 0) return pdfBytes;

  const entries = parseXrefEntries(xrefBody);
  if (!entries) return pdfBytes;

  let denseSize = 1;
  for (const [objectNumber, entry] of entries) {
    if (objectNumber < size && isInUseEntry(entry)) {
      denseSize = Math.max(denseSize, objectNumber + 1);
    }
  }

  let alreadyDense = true;
  for (let objectNumber = 0; objectNumber < denseSize; objectNumber++) {
    if (!entries.has(objectNumber)) {
      alreadyDense = false;
      break;
    }
  }
  if (alreadyDense && denseSize === size) return pdfBytes;

  const rebuiltLines = ['xref', `0 ${denseSize}`];
  for (let objectNumber = 0; objectNumber < denseSize; objectNumber++) {
    rebuiltLines.push(entries.get(objectNumber) ?? FREE_XREF_ENTRY);
  }

  const denseTrailerDict = trailerDict.replace(/\/Size\s+\d+/, `/Size ${denseSize}`);
  const rebuiltTail = `${rebuiltLines.join('\n')}\n\ntrailer\n${denseTrailerDict}\n\nstartxref\n${xrefStart}\n%%EOF\n`;
  const tailBytes = asciiToBytes(rebuiltTail);
  const out = new Uint8Array(xrefStart + tailBytes.length);
  out.set(pdfBytes.slice(0, xrefStart), 0);
  out.set(tailBytes, xrefStart);
  return out;
}
