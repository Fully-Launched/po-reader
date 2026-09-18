import { NextResponse } from "next/server";
import { ServiceTitanClient } from "@/lib/servicetitan/client";

// TEMPORARY / SCRATCH ROUTE -- not part of the product.
//
// One-off helper for the open "Business Unit ID" question in CLAUDE.md: the
// review table currently requires a human to type a ServiceTitan Business
// Unit ID by hand, with no lookup UI, because we don't know the sandbox
// tenant's real Business Unit IDs yet. Hit this route once to get them, note
// the ID(s) you need, then delete this route -- it has no auth beyond the
// production guard below and isn't meant to ship.
//
// GET /api/dev/business-units -> [{ id, name }, ...]
export async function GET() {
  if ((process.env.SERVICETITAN_ENVIRONMENT ?? "integration") === "production") {
    return NextResponse.json(
      { error: "This scratch route is sandbox-only -- refusing to run against production." },
      { status: 403 },
    );
  }

  try {
    const client = new ServiceTitanClient();
    const businessUnits = await client.listBusinessUnits();
    return NextResponse.json(businessUnits.map((bu) => ({ id: bu.id, name: bu.name })));
  } catch (err) {
    console.error("Failed to list ServiceTitan business units:", err);
    return NextResponse.json({ error: "Failed to list business units" }, { status: 502 });
  }
}
