import { PDFDocument } from 'pdf-lib';

/**
 * One printable PDF from stored documents: sorted by postal code (bulk post rates), each letter padded to an
 * even page count so every letter starts on a front page in duplex printing. The documents are not re-rendered.
 */
export async function mergeLetters(letters: { pdf: Buffer | Uint8Array; postalCode: string; sortKey: string }[]) {
  const sorted = [...letters].sort((a, b) => a.postalCode.localeCompare(b.postalCode) || a.sortKey.localeCompare(b.sortKey));
  const out = await PDFDocument.create();
  for (const l of sorted) {
    const src = await PDFDocument.load(l.pdf);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    if (src.getPageCount() % 2) out.addPage([595.28, 841.89]);
  }
  return Buffer.from(await out.save());
}

/** Postal code from address lines; letters without one go last. */
export const postalCodeOf = (lines: string[]) => lines.join(' ').match(/\b\d{5}\b/)?.[0] ?? '99999z';
