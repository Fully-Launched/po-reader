import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedInvoice } from "./types";

// Ported from the comfort-x-design-invoice-tool prototype's
// extraction/extract_invoice.py, validated against a real Arco Supply
// invoice sample. Keep the field shape in sync with ExtractedInvoice.
const EXTRACTION_PROMPT = `You are extracting structured data from a vendor invoice for a \
Purchase Order to be created in ServiceTitan.

First, decide whether the attached document is actually a vendor invoice at all (an \
itemized bill from a vendor for goods/materials/services). Set is_invoice to false if it \
is clearly something else -- an internal memo, a letter, a random unrelated document, a \
blank/unreadable page -- and there is no invoice data to extract. In that case still call \
the tool, but leave the other fields empty/zeroed (vendor_name: "", line_items: [], \
subtotal/total: 0, etc.) and use notes to explain what the document actually is.

If it IS an invoice (even a partial, messy, or low-confidence one), set is_invoice to true \
and extract everything you can -- do not withhold a field just because you're unsure of \
it; extract your best reading and reflect uncertainty via extraction_confidence and notes \
instead. A human will review and correct this before it's submitted anywhere.

Call the extract_invoice tool with the data. Extract every line item -- invoices can have \
30+ line items; do not summarize or omit any.

Field notes:
- project_number: the job/project number referenced on the invoice -- REQUIRED going forward
  (Kevin is switching his invoice PO numbering to use the project number directly, so every
  new invoice should carry one). Look hard for it before giving up: it's not always a
  clearly-labeled field -- some vendors (e.g. Arco Supply) embed it in a footer line like
  "Cost to Location: J700.15" rather than a dedicated field -- check header codes (JOB#,
  ID#, YOUR#) AND footer/memo lines, not just fields explicitly labeled "project" or "job".
  Use null only if you genuinely cannot find one anywhere on the document after a careful
  look (e.g. an older-format invoice) -- do not fabricate one.
- vendor_part_number: the VENDOR's own part/SKU code for that line item, if printed (e.g.
  Arco Supply invoices show codes like "301/D" alongside a generic description). This is
  distinct from any ServiceTitan-internal identifier -- just transcribe whatever code the
  vendor printed. Use null if the line item has no separate part number field.
- freight_amount: the invoice's own freight/shipping charge, if it has one (e.g. Arco Supply
  invoices carry a "FREIGHT: 0.00" line near the totals). This is usually zero but not
  always -- extract the actual printed value, don't assume it's zero. Use null only if the
  invoice has no freight/shipping line at all, not when the line reads "0.00" (that's a
  real value: freight_amount 0).
- If a field is illegible or missing on a genuine invoice, use null (or "" for line item
  description) rather than guessing.
- Set extraction_confidence to "low" if any line item amount is unclear, if the invoice
  clearly references a job/project but you can't pin down the number, OR if you couldn't
  find a project number at all -- project number is now required for every PO, so a missing
  one should flag the invoice for a human to double-check, not pass silently at "high"
  confidence.`;

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
      is_invoice: {
        type: "boolean",
        description: "false if this document is not actually a vendor invoice (e.g. an internal memo or unrelated document)",
      },
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
            vendor_part_number: { type: ["string", "null"] },
          },
          required: ["description", "quantity", "unit_price", "total", "vendor_part_number"],
          additionalProperties: false,
        },
      },
      tax_amount: { type: ["number", "null"] },
      freight_amount: { type: ["number", "null"] },
      subtotal: { type: "number" },
      total: { type: "number" },
      extraction_confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: "string" },
    },
    required: [
      "is_invoice",
      "vendor_name",
      "invoice_number",
      "invoice_date",
      "project_number",
      "line_items",
      "tax_amount",
      "freight_amount",
      "subtotal",
      "total",
      "extraction_confidence",
      "notes",
    ],
    additionalProperties: false,
  },
} as Anthropic.Tool;

interface RawExtraction {
  is_invoice: boolean;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  project_number: string | null;
  line_items: {
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
    vendor_part_number: string | null;
  }[];
  tax_amount: number | null;
  freight_amount: number | null;
  subtotal: number;
  total: number;
  extraction_confidence: "high" | "medium" | "low";
  notes: string;
}

function toExtractedInvoice(raw: RawExtraction): ExtractedInvoice {
  return {
    isInvoice: raw.is_invoice,
    vendorName: raw.vendor_name,
    invoiceNumber: raw.invoice_number,
    invoiceDate: raw.invoice_date,
    projectNumber: raw.project_number,
    lineItems: raw.line_items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      total: item.total,
      vendorPartNumber: item.vendor_part_number,
    })),
    taxAmount: raw.tax_amount,
    freightAmount: raw.freight_amount,
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
