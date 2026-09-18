import { NextRequest, NextResponse } from "next/server";
import { extractInvoice } from "@/lib/extraction";

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
    console.error("Invoice extraction failed:", err);
    return NextResponse.json({ error: "Extraction failed" }, { status: 502 });
  }
}
