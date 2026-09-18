import { NextRequest, NextResponse } from "next/server";
import { extractInvoice, ExtractionTruncatedError } from "@/lib/extraction";

// Raises this function's execution limit above Vercel's default (10s on
// Hobby). 60s covers large multi-page/line-item invoices without hitting
// max_tokens: 16000 generation time. NOTE: Hobby plans cap at 60s regardless
// of this value -- if extraction still times out on genuinely large
// invoices, this needs a Pro/Enterprise plan (up to 300s/900s) rather than a
// higher number here.
export const maxDuration = 60;

// POST /api/extract-invoice
// Accepts a vendor invoice PDF upload (multipart/form-data, field "file"),
// sends it to the Claude API, and returns the structured ExtractedInvoice
// for the frontend review table.
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF" }, { status: 400 });
  }

  const pdfBuffer = Buffer.from(await file.arrayBuffer());

  try {
    const extracted = await extractInvoice(pdfBuffer);
    return NextResponse.json(extracted);
  } catch (err) {
    if (err instanceof ExtractionTruncatedError) {
      console.error("Invoice extraction truncated:", err);
      return NextResponse.json(
        { error: "This invoice is too large to process automatically. Please contact support." },
        { status: 422 },
      );
    }
    console.error("Invoice extraction failed:", err);
    return NextResponse.json({ error: "Extraction failed" }, { status: 502 });
  }
}
