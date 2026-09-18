// Shared types for the extraction result that flows from
// /api/extract-invoice -> review table -> /api/create-po

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitCost: number;
  total: number;
}

export interface ExtractedInvoice {
  vendorName: string;
  lineItems: InvoiceLineItem[];
}
