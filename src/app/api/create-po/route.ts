import { NextRequest, NextResponse } from "next/server";
import type { ExtractedInvoice } from "@/lib/types";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { buildPoPayload, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";
import { resolveServiceTitanVendorName } from "@/lib/servicetitan/vendor-remap";
import { buildLineItemsForVendor } from "@/lib/servicetitan/line-item-strategy";

// Name of the PO Type with "Automatically Receive" enabled. Confirmed to
// exist as "Supply House Run" in the sandbox -- this is the ONLY way a PO
// ends up Received (and a bill auto-generated) via the API, since
// ServiceTitan's own docs confirm PO status cannot be updated after
// creation. This is a ServiceTitan-side setting configured on the PO Type
// itself in Kevin's account -- this app does not set or control receive
// status directly, it only selects which existing PO Type to reference by
// name/ID (see getPoTypeIdByName() below). Re-verify this name once
// production access exists -- it may differ from the sandbox's PO Type
// naming.
const AUTO_RECEIVE_PO_TYPE_NAME =
  process.env.SERVICETITAN_AUTO_RECEIVE_PO_TYPE_NAME ?? "Supply House Run";

interface CreatePoRequestBody {
  invoice: ExtractedInvoice;
  businessUnitId: number;
  // Resolved via the review table's Inventory Location dropdown
  // (GET /api/inventory-locations) -- REQUIRED top-level field on
  // PurchaseOrders_Create, confirmed via a live 400.
  inventoryLocationId: number;
  // Date (YYYY-MM-DD) ServiceTitan requires materials by -- REQUIRED
  // top-level field. Set via a genuinely editable date input in the review
  // table (ReviewTable.tsx), defaulting to today but allowing past dates.
  requiredOn: string;
}

// POST /api/create-po
// Takes the human-reviewed/corrected ExtractedInvoice from the review table
// and creates a Purchase Order in ServiceTitan.
//
// There is deliberately no separate "receive" call here: ServiceTitan's API
// does not support updating PO status after creation ("A purchase order
// status cannot be updated through API" -- confirmed in their developer
// docs). Whether the PO ends up auto-received (and, if enabled, auto-billed)
// is determined ENTIRELY by a ServiceTitan-side "Automatically Receive"
// setting on the selected PO Type (poTypeId), configured in Kevin's
// ServiceTitan account -- this app's payload never sets a status/receive
// field itself, it only picks which already-configured PO Type to
// reference. See the confirmation screen's reminder to double-check receive
// status in ServiceTitan as a safety net for this.
export async function POST(req: NextRequest) {
  const body: CreatePoRequestBody = await req.json();
  const { invoice, businessUnitId, inventoryLocationId, requiredOn } = body;

  if (
    !invoice ||
    typeof businessUnitId !== "number" ||
    typeof inventoryLocationId !== "number" ||
    typeof requiredOn !== "string"
  ) {
    return NextResponse.json(
      { error: "Request body must include 'invoice', 'businessUnitId', 'inventoryLocationId', and 'requiredOn'" },
      { status: 400 },
    );
  }

  // Hard block: the document doesn't look like a vendor invoice at all, so
  // there's nothing meaningful to have reviewed or submitted. Low confidence
  // / missing fields alone do NOT block here -- the review table lets the
  // user correct those before submission, and hasRequiredFields (below) is
  // the real gate on that corrected data.
  if (isNotAnInvoice(invoice)) {
    return NextResponse.json(
      { error: "This document does not appear to be a vendor invoice -- nothing to submit." },
      { status: 422 },
    );
  }

  // Defense in depth -- the review table should already disable submission
  // until these are filled in, but never trust the client alone. Includes
  // project number now (see hasRequiredFields' doc comment) since job
  // attachment is required below, not best-effort.
  if (!hasRequiredFields(invoice)) {
    return NextResponse.json(
      { error: "Missing required fields: vendor name, project number, and at least one valid line item are required." },
      { status: 422 },
    );
  }

  const client = new ServiceTitanClient();

  // Vendor remapping (e.g. invoice text "Supply House" -> ServiceTitan
  // vendor "Chase") happens ONLY here, for vendor resolution -- line-item
  // strategy below matches against the invoice's own vendor text, not this
  // remapped name. See vendor-remap.ts.
  const serviceTitanVendorName = resolveServiceTitanVendorName(invoice.vendorName);
  const vendor = await client.findVendorByName(serviceTitanVendorName);
  if (!vendor) {
    return NextResponse.json(
      { error: `No ServiceTitan vendor found matching "${serviceTitanVendorName}"${serviceTitanVendorName !== invoice.vendorName ? ` (remapped from invoice vendor "${invoice.vendorName}")` : ""}` },
      { status: 422 },
    );
  }

  // Job attachment is now REQUIRED, not best-effort (CONFIRMED on a client
  // call -- Kevin is switching his invoice PO numbering to use the project
  // number directly, so every PO must be tied to a job). hasRequiredFields
  // above already guarantees invoice.projectNumber is present. A missing
  // job match is a hard failure, surfaced clearly, not silently skipped --
  // see ServiceTitanClient.findJobByProjectNumber()'s doc comment for the
  // research behind this lookup (still not live-verified).
  const job = await client.findJobByProjectNumber(invoice.projectNumber as string);
  if (!job) {
    return NextResponse.json(
      {
        error: `No ServiceTitan job found with Job Number "${invoice.projectNumber}". Job attachment is required -- correct the project number in the review table to match an existing ServiceTitan job, or confirm the job exists under a different number.`,
      },
      { status: 422 },
    );
  }

  const poTypeId = await client.getPoTypeIdByName(AUTO_RECEIVE_PO_TYPE_NAME);
  if (!poTypeId) {
    return NextResponse.json(
      { error: `No PO Type named "${AUTO_RECEIVE_PO_TYPE_NAME}" found -- without an Automatically-Receive PO Type, the PO cannot be auto-received` },
      { status: 422 },
    );
  }

  // Per-vendor line-item strategy (bulk consolidation for Arco/Supply House,
  // per-item + catch-all for TEC, strict per-item matching for anything else)
  // -- see line-item-strategy.ts's file header for the full CONFIRMED
  // client-call rules. Matches against the invoice's OWN vendor text, not
  // the ServiceTitan-resolved vendor above.
  const lineItemsResult = await buildLineItemsForVendor(client, invoice.vendorName, invoice.lineItems);
  if ("error" in lineItemsResult) {
    return NextResponse.json({ error: lineItemsResult.error }, { status: 422 });
  }

  const payload = buildPoPayload({
    invoice,
    vendorId: vendor.id,
    jobId: job.id,
    businessUnitId,
    inventoryLocationId,
    poTypeId,
    items: lineItemsResult.items,
    requiredOn,
  });

  try {
    const result = await client.createPurchaseOrder(payload);
    return NextResponse.json(result);
  } catch (err) {
    console.error("PurchaseOrders_Create failed:", err);
    return NextResponse.json({ error: "Failed to create purchase order in ServiceTitan" }, { status: 502 });
  }
}
