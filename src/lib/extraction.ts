import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedInvoice } from "./types";

// Ported from the comfort-x-design-invoice-tool prototype's
// extraction/extract_invoice.py, validated against a real Arco Supply
// invoice sample. Keep the field shape in sync with ExtractedInvoice.
const EXTRACTION_PROMPT = `You are extracting structured data from a vendor invoice for a \
Purchase Order to be created in ServiceTitan.

Read the attached invoice and return ONLY a JSON object (no preamble, no markdown \
fences) with this exact shape:

{
  "vendor_name": string,
  "invoice_number": string,
  "invoice_date": string (YYYY-MM-DD),
  "project_number": string or null,   // the job/project number referenced on the invoice, if any.
                                       // NOTE: this is not always a clearly-labeled field. Some vendors
                                       // (e.g. Arco Supply) embed it in a footer line like
                                       // "Cost to Location: J700.15" rather than a dedicated field --
                                       // look at header codes (JOB#, ID#, YOUR#) AND footer/memo lines,
                                       // not just fields explicitly labeled "project" or "job".
  "line_items": [
    {
      "description": string,
      "quantity": number,
      "unit_price": number,
      "total": number
    }
  ],
  "tax_amount": number or null,
  "subtotal": number,
  "total": number,
  "extraction_confidence": "high" | "medium" | "low",
  "notes": string  // flag anything ambiguous, illegible, or missing -- e.g. "no project number found"
}

If a field is illegible or missing, use null rather than guessing. Set \
extraction_confidence to "low" if the project number or any line item amount is unclear \
-- this signals the tool to route the invoice to human review rather than auto-submitting it.`;

interface RawExtraction {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  project_number: string | null;
  line_items: { description: string; quantity: number; unit_price: number; total: number }[];
  tax_amount: number | null;
  subtotal: number;
  total: number;
  extraction_confidence: "high" | "medium" | "low";
  notes: string;
}

function toExtractedInvoice(raw: RawExtraction): ExtractedInvoice {
  return {
    vendorName: raw.vendor_name,
    invoiceNumber: raw.invoice_number,
    invoiceDate: raw.invoice_date,
    projectNumber: raw.project_number,
    lineItems: raw.line_items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      total: item.total,
    })),
    taxAmount: raw.tax_amount,
    subtotal: raw.subtotal,
    total: raw.total,
    extractionConfidence: raw.extraction_confidence,
    notes: raw.notes,
  };
}

// TODO: Arco's real invoices arrived as ONE PDF containing 18 separate invoices
// (a monthly batch/statement), not one PDF per invoice. If that's how these
// consistently arrive, this needs a batch-aware sibling -- e.g.
// extractInvoiceBatch(pdfBuffer) -> Promise<ExtractedInvoice[]> -- that asks
// Claude to split the document into its constituent invoices before
// extracting each one. Confirm with the client whether this bundled format
// is typical before building that out, since it changes the intake design.

export async function extractInvoice(pdfBuffer: Buffer): Promise<ExtractedInvoice> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBuffer.toString("base64"),
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("Claude's response contained no text block");
  }

  // Defensive cleanup in case the model wraps output in code fences despite instructions
  const rawText = textBlock.text
    .trim()
    .replace(/^```json/, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  let raw: RawExtraction;
  try {
    raw = JSON.parse(rawText);
  } catch (e) {
    throw new Error(
      `Claude's response wasn't valid JSON -- inspect raw output:\n${rawText}`,
      { cause: e },
    );
  }

  return toExtractedInvoice(raw);
}
