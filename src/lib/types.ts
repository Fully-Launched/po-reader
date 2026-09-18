// Shared types for the extraction result that flows from
// /api/extract-invoice -> review table -> /api/create-po.
//
// This schema is ported from the working extraction prototype
// (comfort-x-design-invoice-tool), validated against a real Arco Supply
// invoice. Field shape is deliberately richer than "vendor + line items" --
// invoice_number/date and extraction_confidence/notes exist specifically to
// support the human-review guardrail (see needsHumanReview in
// src/lib/servicetitan/payload-builder.ts) and the PO memo field.

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export type ExtractionConfidence = "high" | "medium" | "low";

export interface ExtractedInvoice {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  /**
   * The job/project number referenced on the invoice, if any. Not always a
   * clearly-labeled field -- some vendors (e.g. Arco Supply) embed it in a
   * footer line like "Cost to Location: J700.15" rather than a dedicated
   * field. Null when the extraction couldn't find one.
   */
  projectNumber: string | null;
  lineItems: InvoiceLineItem[];
  taxAmount: number | null;
  subtotal: number;
  total: number;
  extractionConfidence: ExtractionConfidence;
  notes: string;
}
