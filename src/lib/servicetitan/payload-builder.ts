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

// shipTo.description -- CONFIRMED visible live on a real PO's "Ship To"
// label in ServiceTitan (client). "Sandbox test PO" was a leftover
// sandbox-only value; since CLIENT_SHIP_TO_ADDRESS above is real client
// data used in every environment, this needed a real, production-appropriate
// label too, not a sandbox artifact -- "Main Office" (Kevin's real shipping
// address is his main office) fills that role.
const SHIP_TO_DESCRIPTION = "Main Office";

/**
 * PurchaseOrders_Create's top-level "request" field -- CONFIRMED accepted as
 * an empty object with no further error (part of the PO #19969 success).
 * Its actual purpose/shape is unknown, and per a client call, Kevin doesn't
 * know either -- there is nothing more to learn here from our side. This is
 * a PERMANENT placeholder, not a TODO: do not spend further effort
 * investigating what "request" is supposed to contain.
 */
const REQUEST_PLACEHOLDER = {};

/**
 * A single PurchaseOrders_Create `items[]` entry, already resolved to a real
 * Pricebook skuId. Built by the per-vendor line-item strategy in
 * `line-item-strategy.ts` -- may or may not correspond 1:1 with
 * `invoice.lineItems` (vendors using the "bulk consolidation" or "catch-all"
 * strategy collapse many extracted line items into one or a few of these).
 */
export interface PoLineItem {
  skuId: number;
  description: string;
  vendorPartNumber: string;
  cost: number;
  quantity: number;
}

export interface BuildPoPayloadArgs {
  invoice: ExtractedInvoice;
  vendorId: number;
  /**
   * ServiceTitan job ID -- REQUIRED, not best-effort. CONFIRMED on a client
   * call: every PO must now be tied to a specific job via its project
   * number, since Kevin is switching his invoice PO numbering to use the
   * project number directly. Resolved via
   * ServiceTitanClient.findJobByProjectNumber() in /api/create-po, which
   * fails the request with a clear error if no matching job is found --
   * see CLAUDE.md's "Business logic" section.
   */
  jobId: number;
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
   * The PO's items[] entries, already fully resolved (real skuId, no nulls)
   * -- REQUIRED, and NOT necessarily 1:1 with invoice.lineItems. Built by
   * buildLineItemsForVendor() in line-item-strategy.ts according to the
   * invoice's vendor (bulk consolidation, per-item + catch-all, or strict
   * per-item matching -- see CLAUDE.md's "Business logic" section).
   * buildPoPayload() does no matching/consolidation itself, only assembly.
   */
  items: PoLineItem[];
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
  items,
  requiredOn,
}: BuildPoPayloadArgs): Record<string, unknown> {
  return {
    vendorId,
    // No longer optional -- see BuildPoPayloadArgs' jobId doc comment.
    jobId,
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

    // Hardcoded false, unchanged by the job-attachment-now-required change
    // (client call) -- these are material/restock purchases, not technician
    // labor, so there's no payroll to impact even though a job is now always
    // attached. See "Job attachment is required" in CLAUDE.md.
    impactsTechnicianPayroll: false,
    // Genuinely user-editable in the review table (see BuildPoPayloadArgs'
    // requiredOn doc comment) -- not computed in here.
    requiredOn,
    // shipTo: CONFIRMED real client address + description + shape -- see
    // CLIENT_SHIP_TO_ADDRESS/SHIP_TO_DESCRIPTION above.
    shipTo: {
      address: CLIENT_SHIP_TO_ADDRESS,
      description: SHIP_TO_DESCRIPTION,
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
 * Human-readable line-item extraction accuracy concerns -- shown as a
 * warning banner in the review table, but does NOT block submission.
 *
 * CONFIRMED on a client call: this banner should cover ONLY line-item
 * extraction accuracy, nothing else. Other issues this used to mention
 * (missing vendor name, missing project number, no line items, generic
 * whole-document extraction confidence) are deliberately NOT here anymore --
 * they're either already surfaced as a red-bordered required field the user
 * can't miss (see ReviewTable.tsx's proactive invalid-field styling, keyed
 * off hasRequiredFields()' own checks), or not worth a banner mention if
 * they're fine. Keeping this list to ONE concern keeps the banner itself
 * short (1-2 bullets), not a paragraph of reasoning.
 */
export function reviewWarnings(invoice: ExtractedInvoice): string[] {
  const warnings: string[] = [];
  // Per-item flag, distinct from the whole-document extractionConfidence
  // field (still recorded on ExtractedInvoice, just no longer surfaced
  // here) -- flags which SPECIFIC line items Claude itself wasn't confident
  // about (see InvoiceLineItem.lowConfidence).
  const lowConfidenceCount = invoice.lineItems.filter((item) => item.lowConfidence).length;
  if (lowConfidenceCount > 0) {
    warnings.push(
      `${lowConfidenceCount} line item${lowConfidenceCount === 1 ? "" : "s"} may not have been read accurately -- verify against the original PDF`,
    );
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
 * Project number IS now required (changed on a client call): every PO must
 * be tied to a specific job, since Kevin is switching his invoice PO
 * numbering to use the project number directly. Without one,
 * /api/create-po has nothing to look up a job by -- see
 * ServiceTitanClient.findJobByProjectNumber() and CLAUDE.md's "Business
 * logic" section. (Previously deliberately NOT required, back when job
 * attachment was best-effort/optional -- that's no longer the case.)
 */
export function hasRequiredFields(invoice: ExtractedInvoice): boolean {
  if (!invoice.vendorName.trim()) return false;
  if (!invoice.projectNumber?.trim()) return false;
  if (invoice.lineItems.length === 0) return false;
  if (invoice.lineItems.some((item) => !item.description.trim() || item.quantity <= 0)) return false;
  return true;
}
