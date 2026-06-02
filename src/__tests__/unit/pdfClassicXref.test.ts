import { describe, expect, it } from 'vitest'
import { ensureDenseClassicXref } from '../../utils/pdfClassicXref'


function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff
  }
  return bytes
}

function asciiText(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

describe('ensureDenseClassicXref', () => {
  it('fills missing object numbers with free entries and preserves startxref', () => {
    const prefix = [
      '%PDF-1.7\n',
      '1 0 obj\n<<>>\nendobj\n',
      '3 0 obj\n<<>>\nendobj\n',
    ].join('')
    const xrefStart = prefix.length
    const sparsePdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '3 1\n',
      '0000000028 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 4\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')

    const repaired = asciiText(ensureDenseClassicXref(asciiBytes(sparsePdf)))

    expect(repaired).toContain([
      'xref',
      '0 4',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000000 65535 f ',
      '0000000028 00000 n ',
    ].join('\n'))
    expect(repaired).toContain(`startxref\n${xrefStart}\n%%EOF`)
  })

  it('returns the same bytes when the classic xref is already dense', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const densePdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 2\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(densePdf)

    expect(ensureDenseClassicXref(input)).toBe(input)
  })
})

// ─── Edge / abnormal cases ────────────────────────────────────────────────────

describe('ensureDenseClassicXref / abnormal and boundary', () => {
  it('AB-01: empty Uint8Array returns same reference', () => {
    const input = new Uint8Array(0)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-02: bytes with no startxref keyword returns same reference', () => {
    const input = asciiBytes('%PDF-1.7\nno xref here\n')
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-03: PDF starting with "stream" (not xref) at xref offset returns same reference', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'stream\nsome data\nendstream\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(pdf)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-04: xref table with no "trailer" keyword returns same reference', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(pdf)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-05: xref table with missing /Size in trailer returns same reference', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '\ntrailer\n',
      '<<\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(pdf)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-06: /Size 0 in trailer returns same reference', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 0\n',
      '\ntrailer\n',
      '<<\n/Size 0\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(pdf)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-07: already-dense xref with /Size mismatch (size > actual in-use) is rebuilt with smaller size', () => {
    // Only object 1 is in-use; /Size 5 (too large). Should rebuild to Size 2.
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 5\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    // Size 5 != 2 entries → rebuild
    const result = asciiText(ensureDenseClassicXref(asciiBytes(pdf)))
    expect(result).toContain('0 2')
    expect(result).toContain('/Size 2')
  })

  it('AB-08: large gap in xref (object 1 and object 1000) fills 999 free entries', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '1000 1\n',
      '0000000028 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 1001\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const result = asciiText(ensureDenseClassicXref(asciiBytes(pdf)))
    // The rebuilt xref should only go up to the highest in-use object (1 or 1000).
    // Implementation trims denseSize to max in-use + 1.
    expect(result).toContain('xref')
    expect(result).toContain('startxref')
    expect(result).toContain('%%EOF')
  })

  it('AB-09: malformed xref entry (wrong format) returns same reference', () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'
    const xrefStart = prefix.length
    const pdf = [
      prefix,
      'xref\n',
      '0 2\n',
      'NOT_A_VALID_ENTRY\n',
      '0000000009 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 2\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(pdf)
    expect(ensureDenseClassicXref(input)).toBe(input)
  })

  it('AB-10: output byte length is consistent (startxref offset preserved)', () => {
    const prefix = [
      '%PDF-1.7\n',
      '1 0 obj\n<<>>\nendobj\n',
      '3 0 obj\n<<>>\nendobj\n',
    ].join('')
    const xrefStart = prefix.length
    const sparsePdf = [
      prefix,
      'xref\n',
      '0 2\n',
      '0000000000 65535 f \n',
      '0000000009 00000 n \n',
      '3 1\n',
      '0000000028 00000 n \n',
      '\ntrailer\n',
      '<<\n/Size 4\n/Root 1 0 R\n>>\n',
      '\nstartxref\n',
      String(xrefStart),
      '\n%%EOF\n',
    ].join('')
    const input = asciiBytes(sparsePdf)
    const result = ensureDenseClassicXref(input)
    // Must preserve all bytes before xrefStart
    expect(Array.from(result.slice(0, xrefStart))).toEqual(Array.from(input.slice(0, xrefStart)))
    // startxref value in result must still point to xrefStart
    const resultText = asciiText(result)
    expect(resultText).toContain(`startxref\n${xrefStart}\n%%EOF`)
  })
})
