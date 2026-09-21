// Splits a page range out of a PDF into its own standalone PDF -- used to
// turn one detected invoice's boundary (from detectInvoiceBoundaries() in
// extraction.ts) into a sub-PDF that the existing single-invoice
// extractInvoice() can run on unmodified. Keeps the per-invoice extraction
// path identical for both the single-invoice flow and each invoice inside a
// bundled PDF -- only this splitting step is new.

import { PDFDocument } from "pdf-lib";

/** Returns the PDF's total page count -- used to validate/clamp boundaries from Claude before trusting them. */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdfBuffer);
  return doc.getPageCount();
}

/**
 * Extracts pages [startPage, endPage] (1-indexed, inclusive) into a new
 * standalone PDF. Throws if the range is invalid (caller should validate/
 * clamp against getPdfPageCount() first -- see /api/extract-invoice-page-range).
 */
export async function splitPdfPageRange(pdfBuffer: Buffer, startPage: number, endPage: number): Promise<Buffer> {
  const sourceDoc = await PDFDocument.load(pdfBuffer);
  const pageCount = sourceDoc.getPageCount();
  if (startPage < 1 || endPage < startPage || endPage > pageCount) {
    throw new Error(`Invalid page range [${startPage}, ${endPage}] for a ${pageCount}-page PDF`);
  }

  const outDoc = await PDFDocument.create();
  // pdf-lib page indices are 0-based; our boundaries are 1-indexed inclusive.
  const pageIndices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i);
  const copiedPages = await outDoc.copyPages(sourceDoc, pageIndices);
  copiedPages.forEach((page) => outDoc.addPage(page));

  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}
