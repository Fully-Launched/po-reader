import { NextRequest, NextResponse } from "next/server";

// POST /api/extract-invoice
// Accepts a vendor invoice PDF upload (multipart/form-data), sends it to the
// Claude API with a defined JSON schema for vendor name + line items
// (description, quantity, unit cost, total), and returns the structured
// extraction result (an ExtractedInvoice, see src/lib/types.ts) for the
// frontend review table.
export async function POST(req: NextRequest) {
  // TODO: parse the multipart/form-data request and pull out the uploaded PDF file
  // TODO: send the PDF to the Claude API (ANTHROPIC_API_KEY) using a defined JSON
  //       schema / tool-use definition for { vendorName, lineItems[] }
  // TODO: validate the Claude response against that schema before returning it
  // TODO: return the ExtractedInvoice JSON to the frontend for the review table

  return NextResponse.json<{ error: string }>(
    { error: "Not implemented" },
    { status: 501 },
  );
}
