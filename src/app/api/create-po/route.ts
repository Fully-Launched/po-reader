import { NextRequest, NextResponse } from "next/server";
import type { ExtractedInvoice } from "@/lib/types";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { buildPoPayload, needsHumanReview } from "@/lib/servicetitan/payload-builder";

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

  // Defense in depth -- the review table should already block submission on
  // low-confidence/incomplete extractions, but never trust the client alone.
  if (needsHumanReview(invoice)) {
    return NextResponse.json(
      { error: "Invoice failed the human-review guardrail (low confidence, missing project number, or no line items)" },
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

  if (!invoice.projectNumber) {
    return NextResponse.json(
      { error: "Invoice has no project number -- cannot resolve a ServiceTitan job" },
      { status: 422 },
    );
  }

  // findJobByProjectNumber is not implemented yet (see CLAUDE.md open
  // questions -- needs JPM API research), so this will currently always
  // reject with a 501 rather than silently proceeding with a wrong job.
  let job;
  try {
    job = await client.findJobByProjectNumber(invoice.projectNumber);
  } catch {
    return NextResponse.json(
      { error: "Job lookup by project number is not implemented yet -- see CLAUDE.md open questions" },
      { status: 501 },
    );
  }
  if (!job) {
    return NextResponse.json(
      { error: `No ServiceTitan job found for project number "${invoice.projectNumber}"` },
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

  const payload = buildPoPayload({
    invoice,
    vendorId: vendor.id,
    jobId: job.id,
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
