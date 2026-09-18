import { NextRequest, NextResponse } from "next/server";

// POST /api/create-po
// Takes the human-reviewed/corrected ExtractedInvoice from the review table
// and:
//   1. Runs the ServiceTitan OAuth2 client_credentials flow to get an access token
//   2. Calls ServiceTitan's PurchaseOrders_Create endpoint to create the PO
//   3. Calls the Receipts creation endpoint to receive the PO (which triggers
//      ServiceTitan's auto-bill-creation, if enabled on the client's account)
export async function POST(req: NextRequest) {
  // TODO: parse and validate the reviewed invoice payload from the request body

  // TODO: exchange SERVICETITAN_CLIENT_ID / SERVICETITAN_CLIENT_SECRET for an
  //       access token via the ServiceTitan OAuth2 client_credentials flow
  //       (cache/reuse the token until it expires instead of fetching on every call)

  // TODO: call PurchaseOrders_Create against SERVICETITAN_TENANT_ID, using
  //       SERVICETITAN_APP_KEY as required by ServiceTitan's API, with the
  //       vendor + line items from the request body

  // TODO: call the Receipts creation endpoint for the newly created PO to
  //       receive it (see CLAUDE.md open questions re: auto-bill-creation)

  // TODO: return the created PO id / receipt result to the frontend

  return NextResponse.json<{ error: string }>(
    { error: "Not implemented" },
    { status: 501 },
  );
}
