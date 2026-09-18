import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedInvoice } from "./types";

// Ported from the comfort-x-design-invoice-tool prototype's
// extraction/extract_invoice.py, validated against a real Arco Supply
// invoice sample. Keep the field shape in sync with ExtractedInvoice.
const EXTRACTION_PROMPT = `You are extracting structured data from a vendor invoice for a \
Purchase Order to be created in ServiceTitan.

Read the attached invoice and call the extract_invoice tool with the data. Extract \
every line item -- invoices can have 30+ line items; do not summarize or omit any.

Field notes:
- project_number: the job/project number referenced on the invoice, if any. NOT always a
  clearly-labeled field. Some vendors (e.g. Arco Supply) embed it in a footer line like
  "Cost to Location: J700.15" rather than a dedicated field -- look at header codes
  (JOB#, ID#, YOUR#) AND footer/memo lines, not just fields explicitly labeled "project" or "job".
- If a field is illegible or missing, use null rather than guessing.
- Set extraction_confidence to "low" if the project number or any line item amount is
  unclear -- this signals the tool to route the invoice to human review rather than
  auto-submitting it.`;

// strict: true guarantees tool_use.input validates exactly against this schema on
// success (see claude-api skill -- Strict tool use). additionalProperties: false +
// required are mandatory for strict mode.
const EXTRACT_INVOICE_TOOL: Anthropic.Tool = {
  name: "extract_invoice",
  description: "Record the structured data extracted from a vendor invoice.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      vendor_name: { type: "string" },
      invoice_number: { type: "string" },
      invoice_date: { type: "string", description: "YYYY-MM-DD" },
      project_number: { type: ["string", "null"] },
      line_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
            total: { type: "number" },
          },
          required: ["description", "quantity", "unit_price", "total"],
          additionalProperties: false,
        },
      },
      tax_amount: { type: ["number", "null"] },
      subtotal: { type: "number" },
      total: { type: "number" },
      extraction_confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: "string" },
    },
    required: [
      "vendor_name",
      "invoice_number",
      "invoice_date",
      "project_number",
      "line_items",
      "tax_amount",
      "subtotal",
      "total",
      "extraction_confidence",
      "notes",
    ],
    additionalProperties: false,
  },
} as Anthropic.Tool;

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

// Thrown when Claude's response was cut off by max_tokens before the
// extraction tool call could complete -- distinct from a genuine extraction
// failure so callers can surface a clear, actionable error instead of a
// generic 502 (see /api/extract-invoice).
export class ExtractionTruncatedError extends Error {
  constructor() {
    super("Claude's response was truncated before extraction completed (invoice likely has too many line items)");
    this.name = "ExtractionTruncatedError";
  }
}

// TODO: Arco's real invoices arrived as ONE PDF containing 18 separate invoices
// (a monthly batch/statement), not one PDF per invoice. If that's how these
// consistently arrive, this needs a batch-aware sibling -- e.g.
// extractInvoiceBatch(pdfBuffer) -> Promise<ExtractedInvoice[]> -- that asks
// Claude to split the document into its constituent invoices before
// extracting each one. Confirm with the client whether this bundled format
// is typical before building that out, since it changes the intake design.

// Thrown when the bytes we're about to send don't look like a PDF at all --
// catches a corrupt/mismatched upload before wasting an API call, and gives
// a much clearer error than "messages.0.content.0.pdf.source.base64.data:
// The PDF specified was not valid" from the Claude API.
export class InvalidPdfError extends Error {
  constructor(signature: string) {
    super(`Uploaded file does not look like a PDF -- expected bytes to start with "%PDF", got: ${JSON.stringify(signature)}`);
    this.name = "InvalidPdfError";
  }
}

export async function extractInvoice(pdfBuffer: Buffer): Promise<ExtractedInvoice> {
  const base64Data = pdfBuffer.toString("base64");

  // Sanity check: decode the base64 right back and confirm the standard PDF
  // file signature is intact before spending an API call on it. This is the
  // fastest way to tell "we sent Claude garbage" apart from "the PDF itself
  // is malformed" when debugging a "PDF specified was not valid" error.
  const decodedHead = Buffer.from(base64Data, "base64").subarray(0, 5);
  const signature = decodedHead.toString("latin1");
  console.log(`extractInvoice: pdfBuffer=${pdfBuffer.length} bytes, base64=${base64Data.length} chars, decoded signature=${JSON.stringify(signature)}`);
  if (!signature.startsWith("%PDF")) {
    throw new InvalidPdfError(signature);
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-5",
    // Invoices can run 30+ line items; a low ceiling here was truncating the
    // tool call mid-JSON on larger invoices. 16000 is the SDK's own default
    // recommendation for non-streaming requests (stays under HTTP timeouts
    // while giving line-item-heavy invoices enough room).
    max_tokens: 16000,
    tools: [EXTRACT_INVOICE_TOOL],
    tool_choice: { type: "tool", name: "extract_invoice" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Data,
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  // Check truncation before touching content -- if generation hit the
  // max_tokens ceiling mid-tool-call, the tool_use block (if present at all)
  // may be incomplete. Surface this as a specific, actionable error rather
  // than letting a malformed/partial tool input fail confusingly downstream.
  if (response.stop_reason === "max_tokens") {
    throw new ExtractionTruncatedError();
  }

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUseBlock) {
    throw new Error(`Claude did not call the extract_invoice tool (stop_reason: ${response.stop_reason})`);
  }

  // strict: true guarantees this matches the schema on a normal completion.
  return toExtractedInvoice(toolUseBlock.input as RawExtraction);
}
