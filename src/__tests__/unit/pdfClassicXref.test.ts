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
