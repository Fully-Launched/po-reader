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
//      a generic "request" error -- see the note on SANDBOX_PLACEHOLDER_ADDRESS
//      below and CLAUDE.md for why that's almost certainly duplicate noise
//      tied to these same missing fields, not a wrapper-object mismatch).
//
// NOTE: field names/shapes below are modeled on the publicly documented
// Inventory API shape plus those live 400s' error detail -- NOT verified
// against a full live schema (developer.servicetitan.io's API reference is
// a JS-rendered page that couldn't be fetched for this fix). Verify against
// the live API reference before this goes to production.

import type { ExtractedInvoice } from "../types";

/**
 * SANDBOX PLACEHOLDER ADDRESS -- NOT CONFIRMED AS COMFORT X DESIGN'S REAL
 * SHIPPING/RECEIVING ADDRESS. Pulled from ad-hoc test invoice data purely to
 * get sandbox PurchaseOrders_Create calls past validation while the real
 * shipTo/shipping schema and the client's actual address are unconfirmed.
 * MUST be replaced with the client-provided address (or a real address
 * lookup) before any production use -- see CLAUDE.md open questions.
 *
 * Shape is a best-effort guess (street/city/state/zip/country, matching the
 * address shape ServiceTitan uses elsewhere in their API, e.g. Customer/Job
 * locations) -- NOT verified against PurchaseOrders_Create's actual schema.
 */
const SANDBOX_PLACEHOLDER_ADDRESS = {
  name: "Comfort X Design, Inc.",
  street: "510 S Spring Road",
  // Was `null` -- a live 400 reported "shipTo.Address.Unit is required".
  // Keeping the key lowercase ("unit"), NOT switching to "Unit": the prior
  // live 400 for this same shipTo object named "shipTo.address"/
  // "shipTo.description" in lowercase, matching our sent keys exactly, and
  // those errors cleared once we sent those exact lowercase keys -- direct
  // evidence ServiceTitan reads this object's keys as we send them, not
  // PascalCase. ("Address"/"Unit" in the error text most likely reflects
  // ServiceTitan's internal C# property names in their error-message
  // formatting, not the expected JSON key.) So `null` failing a
  // "required" check, not a key mismatch, is the more likely cause --
  // switched to "" (empty string) since there's no real unit/suite number
  // for this placeholder. Confirm against the next live response.
  unit: "",
  city: "Elmhurst",
  state: "IL",
  zip: "60126",
  country: "USA",
};

/**
 * shipTo/shipping SHAPE CORRECTION (from a live PurchaseOrders_Create 400 on
 * a real 56-line-item Arco invoice): the original guess of sending the same
 * flat SANDBOX_PLACEHOLDER_ADDRESS object for both fields was wrong on TWO
 * counts, confirmed by the error response itself:
 *
 * 1. shipTo needs a nested shape -- the error named
 *    "shipTo.address"/"shipTo.description" as missing required properties
 *    UNDER shipTo, meaning shipTo is `{ address: {...}, description: "..." }`,
 *    not a flat address object. CONFIRMED via live 400 -- error cleared once
 *    this shape was sent.
 * 2. shipping is NOT an address at all, and NOT a string either -- a
 *    follow-up live error ("Could not convert string to decimal: Ground")
 *    confirms shipping is a NUMBER: a shipping/freight COST, not a carrier or
 *    method name. CONFIRMED. 0 matches the sample invoice's own
 *    "FREIGHT: 0.00" line, so it's a reasonable sandbox default, not an
 *    arbitrary placeholder.
 */
const SANDBOX_PLACEHOLDER_SHIP_DESCRIPTION = "Sandbox test PO";
// Shipping/freight cost as a number -- confirmed via live 400 (see comment
// above). 0 mirrors the sample invoice's own "FREIGHT: 0.00" line.
const SANDBOX_PLACEHOLDER_SHIPPING_COST = 0;

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
}

export function buildPoPayload({
  invoice,
  vendorId,
  jobId,
  businessUnitId,
  inventoryLocationId,
  poTypeId,
  lineItemSkuIds,
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
    // No "status" field -- status can't be set here. It's determined entirely
    // by whether poTypeId refers to an Automatically-Receive-enabled PO Type.

    // --- Fields added for the second live 400 (see file header) ---

    // These invoices are general inventory/bulk restock purchases with no
    // job or technician attached (see "Job attachment is optional" in
    // CLAUDE.md) -- there's no payroll to impact.
    impactsTechnicianPayroll: false,
    // Not yet user-facing (see CLAUDE.md open questions) -- defaults to
    // today, just to give ServiceTitan a valid date. Revisit if
    // ServiceTitan expects something more specific (e.g. vendor's quoted
    // lead time) once this is exposed in the UI.
    requiredOn: new Date().toISOString().slice(0, 10),
    // SANDBOX PLACEHOLDER -- see the shipTo/shipping shape correction comment
    // above. Both shapes now CONFIRMED via live 400s: shipTo is an
    // { address, description } wrapper; shipping is a numeric freight cost,
    // not an address or a carrier/method string.
    shipTo: {
      address: SANDBOX_PLACEHOLDER_ADDRESS,
      description: SANDBOX_PLACEHOLDER_SHIP_DESCRIPTION,
    },
    shipping: SANDBOX_PLACEHOLDER_SHIPPING_COST,
    // Placeholder for the last uncleared error from the live 400s: a
    // required top-level "request" field, shape still totally unknown. {} is
    // the simplest guess -- CLAUDE.md's existing hypothesis is that this is
    // actually ASP.NET duplicate-validation-key noise tied to the
    // now-fixed shipTo/shipping fields, not a real field at all, so this may
    // turn out to be unnecessary or even wrong. Log/inspect the next live
    // response and remove this if "request" was never a real field, or fix
    // its shape once the error (if any) names what's missing inside it.
    request: {},
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
