// Converts a (human-reviewed) ExtractedInvoice into the shape ServiceTitan's
// PurchaseOrders_Create endpoint expects.
//
// Ported from the comfort-x-design-invoice-tool prototype's
// servicetitan/payload_builder.py.
//
// NOTE: field names below are modeled on the publicly documented Inventory
// API shape. Verify exact field names (e.g. whether tax is PO-level or
// per-line -- confirmed PO-level against a real Arco Supply sample) against
// the live API reference before this goes to production.

import type { ExtractedInvoice } from "../types";

export interface BuildPoPayloadArgs {
  invoice: ExtractedInvoice;
  vendorId: number;
  jobId: number;
  businessUnitId: number;
  /**
   * ID of a PO Type with "Automatically Receive" enabled (e.g. "Supply House
   * Run" in the sandbox) -- REQUIRED. This is the only way status becomes
   * Received and a bill auto-generates, since ServiceTitan's API confirms PO
   * status cannot be updated after creation. See
   * ServiceTitanClient.getPoTypeIdByName().
   */
  poTypeId: number;
}

export function buildPoPayload({
  invoice,
  vendorId,
  jobId,
  businessUnitId,
  poTypeId,
}: BuildPoPayloadArgs): Record<string, unknown> {
  const items = invoice.lineItems.map((item) => ({
    skuName: item.description,
    quantity: item.quantity,
    price: item.unitPrice,
    total: item.total,
  }));

  return {
    vendorId,
    jobId,
    businessUnitId,
    typeId: poTypeId,
    date: invoice.invoiceDate,
    memo: `Auto-created from vendor invoice #${invoice.invoiceNumber || "unknown"}`,
    items,
    tax: invoice.taxAmount,
    // No "status" field -- status can't be set here. It's determined entirely
    // by whether poTypeId refers to an Automatically-Receive-enabled PO Type.
  };
}

/**
 * Simple guardrail: flag anything not clearly high-confidence for manual
 * review before it's ever submitted to ServiceTitan. This is the safety
 * check behind the review table step in the frontend.
 */
export function needsHumanReview(invoice: ExtractedInvoice): boolean {
  if (invoice.extractionConfidence !== "high") return true;
  if (!invoice.projectNumber) return true;
  if (invoice.lineItems.length === 0) return true;
  return false;
}
