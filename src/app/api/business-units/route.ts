import { NextResponse } from "next/server";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { upstreamFailureError } from "@/lib/error-messages";

// GET /api/business-units
// Lists ServiceTitan Business Units for the review table's Business Unit
// dropdown (see ReviewTable.tsx) -- replaces manual Business Unit ID entry.
// Supersedes the earlier temporary /api/dev/business-units scratch route
// now that this is a real, permanent part of the review flow.
export async function GET() {
  try {
    const client = new ServiceTitanClient();
    const businessUnits = await client.listBusinessUnits();
    return NextResponse.json(businessUnits.map((bu) => ({ id: bu.id, name: bu.name })));
  } catch (err) {
    console.error("Failed to list ServiceTitan business units:", err);
    return NextResponse.json({ error: upstreamFailureError("list Business Units from ServiceTitan") }, { status: 502 });
  }
}
