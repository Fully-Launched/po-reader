import { NextRequest, NextResponse } from "next/server";
import { extractInvoice, ExtractionTruncatedError, InvalidPdfError } from "@/lib/extraction";
import { getPdfPageCount, splitPdfPageRange } from "@/lib/pdf-split";
import { upstreamFailureError } from "@/lib/error-messages";

// Same reasoning as /api/extract-invoice's maxDuration -- a single invoice's
// worth of pages, so no larger a budget than the plain single-invoice route.
export const maxDuration = 60;

// POST /api/extract-invoice-page-range
// Extracts ONE invoice from a bundled PDF, given the page range a prior
// /api/detect-invoice-boundaries call identified for it. Splits out just
// those pages (splitPdfPageRange()) and runs the SAME extractInvoice() the
// single-invoice flow uses -- see CLAUDE.md's "Multi-invoice batch flow".
//
// The client re-sends the FULL original PDF file on every call (once per
// queued invoice) rather than the server caching split pages between
// requests -- this app has no persistence layer to cache anything
// server-side across requests (consistent with the rest of the codebase),
// and re-sending a business PDF (at most a few MB) is cheap compared to
// standing up real server-side file storage for what's expected to be a
// handful of requests per upload.
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");
  const startPageRaw = formData.get("startPage");
  const endPageRaw = formData.get("endPage");

  if (!(file instanceof File) || typeof startPageRaw !== "string" || typeof endPageRaw !== "string") {
    return NextResponse.json(
      { error: "Request must include 'file', 'startPage', and 'endPage' in form data." },
      { status: 400 },
    );
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF." }, { status: 400 });
  }
  const startPage = Number(startPageRaw);
  const endPage = Number(endPageRaw);
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    return NextResponse.json({ error: "'startPage'/'endPage' must be positive integers with startPage <= endPage." }, { status: 400 });
  }

  const pdfBuffer = Buffer.from(await file.arrayBuffer());

  try {
    // Clamp against the PDF's real page count rather than trusting the
    // boundary blindly -- detectInvoiceBoundaries() is a Claude call, not a
    // guaranteed-correct parser, and an out-of-range request should fail
    // clearly here rather than as a confusing pdf-lib error deeper in.
    const pageCount = await getPdfPageCount(pdfBuffer);
    if (endPage > pageCount) {
      return NextResponse.json(
        { error: `Requested page range [${startPage}, ${endPage}] exceeds this PDF's ${pageCount} pages.` },
        { status: 400 },
      );
    }

    const subPdfBuffer = await splitPdfPageRange(pdfBuffer, startPage, endPage);
    const extracted = await extractInvoice(subPdfBuffer);
    return NextResponse.json(extracted);
  } catch (err) {
    if (err instanceof ExtractionTruncatedError) {
      console.error("Invoice extraction (page range) truncated:", err);
      return NextResponse.json(
        { error: "This invoice is too large to process automatically -- contact support to process it manually." },
        { status: 422 },
      );
    }
    if (err instanceof InvalidPdfError) {
      console.error("Invalid PDF upload (page range):", err);
      return NextResponse.json(
        { error: "The uploaded file doesn't look like a valid PDF -- check the file and try again." },
        { status: 400 },
      );
    }
    console.error("Invoice extraction (page range) failed:", err);
    return NextResponse.json({ error: upstreamFailureError("extract data from this invoice") }, { status: 502 });
  }
}
