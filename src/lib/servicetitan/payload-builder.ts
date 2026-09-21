// Converts a (human-reviewed) ExtractedInvoice into the shape ServiceTitan's
// PurchaseOrders_Create endpoint expects.
//
// Ported from the comfort-x-design-invoice-tool prototype's
// servicetitan/payload_builder.py, then corrected TWICE against live 400s
// from PurchaseOrders_Create:
//   1. Item-level: the prototype's field names (skuName/price) were wrong,
//      and each item also requires a real skuId referencing an existing
//      ServiceTitan Pricebook item -- see
//      ServiceTitanClient.findMaterialSkuIdByDescription() and the
//      "Line-item -> pricebook matching" open question in CLAUDE.md.
//   2. Top-level: once item-level validation passed, a second 400 surfaced
//      shipTo, shipping, requiredOn, inventoryLocationId, and
//      impactsTechnicianPayroll as missing required top-level fields (plus
//      a "request" field -- see the note near REQUEST_PLACEHOLDER below).
//      A real end-to-end sandbox test (PO #19969, 56 line items, correctly
//      auto-received) confirms all of these shapes now work.
//
// NOTE: field names/shapes below are modeled on the publicly documented
// Inventory API shape plus live 400s' error detail, and confirmed working
// via a real PO creation (see above) -- but individual endpoints not
// exercised by that one test (see per-field notes) remain unverified against
// a full live schema. Re-verify against the live API reference before
// relying on anything not explicitly marked CONFIRMED below.

import type { ExtractedInvoice } from "../types";

/**
 * Comfort x Design's CONFIRMED REAL shipping/receiving address -- 510 South
 * Spring Road, Elmhurst, IL 60126, no unit/suite (confirmed on a client call
 * with Kevin). This is NOT a placeholder or a guess; it's the actual address
 * to use for `shipTo` in every environment, sandbox and production alike.
 *
 * The nested shape (`{ address: {...}, description: "..." }` under `shipTo`,
 * with `address.unit` required and non-null) is CONFIRMED via live 400s and
 * a successful PO creation (PO #19969) -- see CLAUDE.md's top-level-fields
 * correction for the full trail.
 */
const CLIENT_SHIP_TO_ADDRESS = {
  name: "Comfort X Design, Inc.",
  street: "510 S Spring Road",
  unit: "", // Confirmed: no unit/suite number for this address.
  city: "Elmhurst",
  state: "IL",
  zip: "60126",
  country: "USA",
};

// shipTo.description -- NOT addressed by the client's address confirmation
// (only the address itself was confirmed); still an unconfirmed placeholder
// pending a real value.
const PLACEHOLDER_SHIP_DESCRIPTION = "Sandbox test PO";

/**
 * PurchaseOrders_Create's top-level "request" field -- CONFIRMED accepted as
 * an empty object with no further error (part of the PO #19969 success).
 * Its actual purpose/shape is unknown, and per a client call, Kevin doesn't
 * know either -- there is nothing more to learn here from our side. This is
 * a PERMANENT placeholder, not a TODO: do not spend further effort
 * investigating what "request" is supposed to contain.
 */
const REQUEST_PLACEHOLDER = {};

export interface BuildPoPayloadArgs {
  invoice: ExtractedInvoice;
  vendorId: number;
  /**
   * ServiceTitan job ID, if one was resolved. Most of these invoices are
   * general inventory/bulk restock purchases that aren't tied to a specific
   * job -- see CLAUDE.md open questions (pending final confirmation from the
   * client on whether any of their invoices ARE job-tied). Attach it
   * best-effort when a project number was extracted and a matching job was
   * found; omit it otherwise rather than blocking PO creation on it.
   */
  jobId?: number;
  businessUnitId: number;
  /**
   * ServiceTitan Inventory Location ID -- REQUIRED top-level field (confirmed
   * via a live 400 once item-level validation passed). Resolved from the
   * review table's Inventory Location dropdown (GET /api/inventory-locations
   * -> ServiceTitanClient.listInventoryLocations()), same pattern as
   * businessUnitId.
   */
  inventoryLocationId: number;
  /**
   * ID of a PO Type with "Automatically Receive" enabled (e.g. "Supply House
   * Run" in the sandbox) -- REQUIRED. This is the only way status becomes
   * Received and a bill auto-generates, since ServiceTitan's API confirms PO
   * status cannot be updated after creation. See
   * ServiceTitanClient.getPoTypeIdByName().
   */
  poTypeId: number;
  /**
   * Resolved ServiceTitan Pricebook Material skuId for each line item, in
   * the SAME ORDER as invoice.lineItems -- REQUIRED. ServiceTitan's
   * PurchaseOrders_Create rejects items[] entries with a 400 unless skuId
   * references a real Pricebook item; free-text descriptions alone are not
   * accepted. Resolve these via
   * ServiceTitanClient.findMaterialSkuIdByDescription() before calling
   * buildPoPayload() -- this function does no lookups itself, so every
   * entry here must already be resolved (no nulls).
   */
  lineItemSkuIds: number[];
  /**
   * Date (YYYY-MM-DD) ServiceTitan requires materials by -- REQUIRED
   * top-level field. Genuinely user-editable in the review table (defaults
   * to today, but the client needs to be able to backdate it), not a fixed
   * placeholder computed in here -- see ReviewTable.tsx's requiredOn input.
   */
  requiredOn: string;
}

export function buildPoPayload({
  invoice,
  vendorId,
  jobId,
  businessUnitId,
  inventoryLocationId,
  poTypeId,
  lineItemSkuIds,
  requiredOn,
}: BuildPoPayloadArgs): Record<string, unknown> {
  if (lineItemSkuIds.length !== invoice.lineItems.length) {
    throw new Error(
      `lineItemSkuIds length (${lineItemSkuIds.length}) does not match invoice.lineItems length (${invoice.lineItems.length})`,
    );
  }

  const items = invoice.lineItems.map((item, i) => ({
    skuId: lineItemSkuIds[i],
    description: item.description,
    vendorPartNumber: item.vendorPartNumber ?? "",
    cost: item.unitPrice,
    quantity: item.quantity,
  }));

  return {
    vendorId,
    // Omitted entirely (not sent as null/undefined) when no job was resolved
    // -- most of these are bulk/inventory purchases with no job to attach.
    ...(jobId !== undefined ? { jobId } : {}),
    businessUnitId,
    inventoryLocationId,
    typeId: poTypeId,
    date: invoice.invoiceDate,
    memo: `Auto-created from vendor invoice #${invoice.invoiceNumber || "unknown"}`,
    items,
    tax: invoice.taxAmount,
    // No "status"/"autoReceive" field here, and this payload never sets one:
    // status is NOT something this app's payload controls. It's entirely a
    // ServiceTitan-side "Automatically Receive" setting on the PO TYPE
    // (poTypeId) itself, configured in Kevin's ServiceTitan account -- this
    // code's only role is selecting which existing, already-configured PO
    // Type to reference by ID (see ServiceTitanClient.getPoTypeIdByName()).
    // If that PO Type's setting is ever changed or renamed on the client's
    // account, this app has no way to detect or control that.

    // --- Fields added for the second live 400 (see file header) ---

    // These invoices are general inventory/bulk restock purchases with no
    // job or technician attached (see "Job attachment is optional" in
    // CLAUDE.md) -- there's no payroll to impact.
    impactsTechnicianPayroll: false,
    // Genuinely user-editable in the review table (see BuildPoPayloadArgs'
    // requiredOn doc comment) -- not computed in here.
    requiredOn,
    // shipTo: CONFIRMED real client address + confirmed shape -- see
    // CLIENT_SHIP_TO_ADDRESS above.
    shipTo: {
      address: CLIENT_SHIP_TO_ADDRESS,
      description: PLACEHOLDER_SHIP_DESCRIPTION,
    },
    // shipping: CONFIRMED numeric freight cost (see file header) -- now
    // pulled from the invoice's own extracted freight line
    // (ExtractedInvoice.freightAmount, editable in the review table) rather
    // than hardcoded. Defaults to 0 only when no freight line was found.
    shipping: invoice.freightAmount ?? 0,
    // CONFIRMED accepted, permanent placeholder -- see REQUEST_PLACEHOLDER
    // above. Do not remove or investigate further.
    request: REQUEST_PLACEHOLDER,
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
    warnings.push("no project number found -- expected for bulk/inventory purchases not tied to a job, but worth a glance if this one should be job-tied");
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
 *
 * Project number is deliberately NOT required: most of these invoices are
 * general inventory/bulk restock purchases that aren't tied to a specific
 * job (see CLAUDE.md open questions). Job attachment in /api/create-po is
 * best-effort when a project number IS present, never a submission blocker.
 */
export function hasRequiredFields(invoice: ExtractedInvoice): boolean {
  if (!invoice.vendorName.trim()) return false;
  if (invoice.lineItems.length === 0) return false;
  if (invoice.lineItems.some((item) => !item.description.trim() || item.quantity <= 0)) return false;
  return true;
}
