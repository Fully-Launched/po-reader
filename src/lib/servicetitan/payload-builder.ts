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
 * Human-readable reasons this invoice is worth a second look before
 * submitting -- shown as a warning banner in the review table, but does NOT
 * block submission. Low confidence / missing fields are expected outcomes of
 * extraction on a messy real-world invoice; the fix is letting the user
 * correct the draft, not refusing to show it. Only isNotAnInvoice() and
 * hasRequiredFields() below are actual submission gates.
 */
export function reviewWarnings(invoice: ExtractedInvoice): string[] {
  const warnings: string[] = [];
  if (invoice.extractionConfidence !== "high") {
    warnings.push(`extraction confidence is "${invoice.extractionConfidence}"`);
  }
  if (!invoice.vendorName.trim()) {
    warnings.push("vendor name not confidently matched");
  }
  if (!invoice.projectNumber?.trim()) {
    warnings.push("no project number found");
  }
  if (invoice.lineItems.length === 0) {
    warnings.push("no line items extracted");
  }
  return warnings;
}

/** True if there's anything worth flagging in the warning banner (see reviewWarnings). */
export function needsHumanReview(invoice: ExtractedInvoice): boolean {
  return reviewWarnings(invoice).length > 0;
}

/**
 * The one hard-block condition: the document doesn't look like a vendor
 * invoice at all (e.g. an internal memo), so there's no meaningful partial
 * data to edit into a draft. Everything else is an editable, submittable
 * draft -- see reviewWarnings/needsHumanReview for the non-blocking case.
 */
export function isNotAnInvoice(invoice: ExtractedInvoice): boolean {
  return !invoice.isInvoice;
}

/**
 * The actual submission gate: required fields must be filled in, whether by
 * extraction or by manual correction in the review table. Confidence and
 * "was this auto-extracted vs. hand-typed" are irrelevant here -- only
 * whether the data needed to create a ServiceTitan PO is present.
 */
export function hasRequiredFields(invoice: ExtractedInvoice): boolean {
  if (!invoice.vendorName.trim()) return false;
  if (!invoice.projectNumber?.trim()) return false;
  if (invoice.lineItems.length === 0) return false;
  if (invoice.lineItems.some((item) => !item.description.trim() || item.quantity <= 0)) return false;
  return true;
}
