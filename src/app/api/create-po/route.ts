import { NextRequest, NextResponse } from "next/server";
import type { ExtractedInvoice } from "@/lib/types";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { buildPoPayload, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";

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
  // until these are filled in, but never trust the client alone.
  if (!hasRequiredFields(invoice)) {
    return NextResponse.json(
      { error: "Missing required fields: vendor name and at least one valid line item are required." },
      { status: 422 },
    );
  }

  const client = new ServiceTitanClient();

  const vendor = await client.findVendorByName(invoice.vendorName);
  if (!vendor) {
    return NextResponse.json(
      { error: `No ServiceTitan vendor found matching "${invoice.vendorName}"` },
      { status: 422 },
    );
  }

  // Job attachment is best-effort, not required: these invoices are general
  // inventory/bulk restock purchases, not tied to specific jobs (pending
  // final confirmation from the client on whether any of their invoices ARE
  // job-tied -- see CLAUDE.md open questions). If a project number was
  // extracted, try to resolve a matching job and attach it; if there's no
  // project number, no match, or the lookup isn't implemented yet
  // (findJobByProjectNumber currently always throws -- see CLAUDE.md), just
  // proceed without a job rather than blocking PO creation on it.
  let jobId: number | undefined;
  if (invoice.projectNumber) {
    try {
      const job = await client.findJobByProjectNumber(invoice.projectNumber);
      if (job) {
        jobId = job.id;
      } else {
        console.warn(`No ServiceTitan job found for project number "${invoice.projectNumber}" -- proceeding without a job`);
      }
    } catch (err) {
      console.warn(`Job lookup by project number failed or is not implemented -- proceeding without a job:`, err);
    }
  }

  const poTypeId = await client.getPoTypeIdByName(AUTO_RECEIVE_PO_TYPE_NAME);
  if (!poTypeId) {
    return NextResponse.json(
      { error: `No PO Type named "${AUTO_RECEIVE_PO_TYPE_NAME}" found -- without an Automatically-Receive PO Type, the PO cannot be auto-received` },
      { status: 422 },
    );
  }

  // Each line item needs a real ServiceTitan Pricebook skuId -- PurchaseOrders_Create
  // rejects free-text-only items with a 400. This is a naive first-pass
  // description match, not the real matching strategy (see
  // ServiceTitanClient.findMaterialSkuIdByDescription and the "Line-item ->
  // pricebook matching" open question in CLAUDE.md). Fail loudly and name
  // exactly which line items didn't match, rather than guessing a SKU or
  // silently dropping the item.
  const lineItemSkuIds: number[] = [];
  const unmatchedDescriptions: string[] = [];
  for (const item of invoice.lineItems) {
    const skuId = await client.findMaterialSkuIdByDescription(item.description);
    if (skuId === null) {
      unmatchedDescriptions.push(item.description);
    } else {
      lineItemSkuIds.push(skuId);
    }
  }
  if (unmatchedDescriptions.length > 0) {
    return NextResponse.json(
      {
        error: `No matching ServiceTitan Pricebook item found for: ${unmatchedDescriptions.map((d) => `"${d}"`).join(", ")}. Correct the description in the review table to match an existing Pricebook item name, or resolve the line-item-to-pricebook matching strategy (see CLAUDE.md open questions) before this invoice can be submitted.`,
      },
      { status: 422 },
    );
  }

  const payload = buildPoPayload({
    invoice,
    vendorId: vendor.id,
    jobId,
    businessUnitId,
    inventoryLocationId,
    poTypeId,
    lineItemSkuIds,
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
