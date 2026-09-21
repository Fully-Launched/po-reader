import { NextRequest, NextResponse } from "next/server";
import type { InvoiceLineItem } from "@/lib/types";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { buildLineItemsForVendor } from "@/lib/servicetitan/line-item-strategy";

interface PreviewRequestBody {
  vendorName: string;
  lineItems: InvoiceLineItem[];
}

// POST /api/line-item-match-preview
// Read-only preview of buildLineItemsForVendor()'s Pricebook match count for
// the review table's "X/Y items matched to Pricebook" indicator -- calls the
// SAME function /api/create-po uses at submission time, just to surface the
// counts, not to create a PO. Only useful for vendors whose strategy
// actually runs per-item matching (catch-all/strict); bulk-consolidation
// vendors get matchSummary: null, which the review table treats as "don't
// show the indicator" -- see line-item-strategy.ts.
export async function POST(req: NextRequest) {
  const body: PreviewRequestBody = await req.json();
  const { vendorName, lineItems } = body;

  if (typeof vendorName !== "string" || !Array.isArray(lineItems)) {
    return NextResponse.json(
      { error: "Request body must include 'vendorName' and 'lineItems'" },
      { status: 400 },
    );
  }

  try {
    const client = new ServiceTitanClient();
    const result = await buildLineItemsForVendor(client, vendorName, lineItems);
    if ("error" in result) {
      // Not a hard failure for a PREVIEW -- e.g. a strict-strategy vendor
      // with unmatched items, or a missing catch-all Pricebook entry. Report
      // it so the review table can choose to surface or ignore it, but this
      // is not the same as /api/create-po's submission-time 422.
      return NextResponse.json({ matchSummary: null, error: result.error });
    }
    return NextResponse.json({ matchSummary: result.matchSummary });
  } catch (err) {
    console.error("Failed to compute line-item match preview:", err);
    return NextResponse.json({ error: "Failed to compute Pricebook match preview" }, { status: 502 });
  }
}
