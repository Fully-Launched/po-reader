import { NextRequest, NextResponse } from "next/server";
import type { ExtractedInvoice } from "@/lib/types";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { buildPoPayload, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";

// Name of the PO Type with "Automatically Receive" enabled. Confirmed to
// exist as "Supply House Run" in the sandbox -- this is the ONLY way a PO
// ends up Received (and a bill auto-generated) via the API, since
// ServiceTitan's own docs confirm PO status cannot be updated after
// creation. Re-verify this name once production access exists -- it may
// differ from the sandbox's PO Type naming.
const AUTO_RECEIVE_PO_TYPE_NAME =
  process.env.SERVICETITAN_AUTO_RECEIVE_PO_TYPE_NAME ?? "Supply House Run";

interface CreatePoRequestBody {
  invoice: ExtractedInvoice;
  // No lookup exists yet for which ServiceTitan business unit a PO should be
  // assigned to (see CLAUDE.md open questions) -- the frontend must supply
  // it until that's built.
  businessUnitId: number;
}

// POST /api/create-po
// Takes the human-reviewed/corrected ExtractedInvoice from the review table
// and creates + auto-receives a Purchase Order in ServiceTitan.
//
// There is deliberately no separate "receive" call here: ServiceTitan's API
// does not support updating PO status after creation ("A purchase order
// status cannot be updated through API" -- confirmed in their developer
// docs). Receiving (and auto-bill-creation, if enabled on the client's
// account) happens automatically at creation time, purely because the PO is
// created with a PO Type that has "Automatically Receive" enabled.
export async function POST(req: NextRequest) {
  const body: CreatePoRequestBody = await req.json();
  const { invoice, businessUnitId } = body;

  if (!invoice || typeof businessUnitId !== "number") {
    return NextResponse.json(
      { error: "Request body must include 'invoice' and 'businessUnitId'" },
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

  const payload = buildPoPayload({
    invoice,
    vendorId: vendor.id,
    jobId,
    businessUnitId,
    poTypeId,
  });

  try {
    const result = await client.createPurchaseOrder(payload);
    return NextResponse.json(result);
  } catch (err) {
    console.error("PurchaseOrders_Create failed:", err);
    return NextResponse.json({ error: "Failed to create purchase order in ServiceTitan" }, { status: 502 });
  }
}
