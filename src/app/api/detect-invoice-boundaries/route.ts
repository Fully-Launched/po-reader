import { NextRequest, NextResponse } from "next/server";
import { detectInvoiceBoundaries, ExtractionTruncatedError, InvalidPdfError } from "@/lib/extraction";
import { upstreamFailureError } from "@/lib/error-messages";

// Boundary-only output is tiny -- this pass never needs anywhere near
// /api/extract-invoice's 60s, but kept generous since it still reads a
// potentially large bundled PDF in full.
export const maxDuration = 30;

// POST /api/detect-invoice-boundaries
// First step of the upload flow (see InvoiceUploader.tsx): runs BEFORE any
// full extraction, on every upload. Identifies whether the PDF contains one
// invoice or a bundle of several (Arco's real sample: 18 invoices in one
// PDF, plus a non-invoice cover/index page) -- see CLAUDE.md's "Multi-invoice
// batch flow" section. A single-boundary result means "not a bundle"; the
// frontend falls back to the existing single-invoice flow unchanged in that
// case, calling /api/extract-invoice directly rather than
// /api/extract-invoice-page-range.
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data." }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF." }, { status: 400 });
  }

  const pdfBuffer = Buffer.from(await file.arrayBuffer());

  try {
    const boundaries = await detectInvoiceBoundaries(pdfBuffer);
    return NextResponse.json({ boundaries });
  } catch (err) {
    if (err instanceof ExtractionTruncatedError) {
      console.error("Invoice boundary detection truncated:", err);
      return NextResponse.json(
        { error: "This document is too large to process automatically -- contact support to process it manually." },
        { status: 422 },
      );
    }
    if (err instanceof InvalidPdfError) {
      console.error("Invalid PDF upload:", err);
      return NextResponse.json(
        { error: "The uploaded file doesn't look like a valid PDF -- check the file and try again." },
        { status: 400 },
      );
    }
    console.error("Invoice boundary detection failed:", err);
    return NextResponse.json({ error: upstreamFailureError("scan this document") }, { status: 502 });
  }
}
