import { NextResponse } from "next/server";
import { ServiceTitanClient } from "@/lib/servicetitan/client";
import { upstreamFailureError } from "@/lib/error-messages";

// GET /api/inventory-locations
// Lists ServiceTitan Inventory Locations for the review table's Inventory
// Location dropdown (same pattern as /api/business-units) -- the user picks
// a name, never a raw ID.
export async function GET() {
  try {
    const client = new ServiceTitanClient();
    const locations = await client.listInventoryLocations();
    return NextResponse.json(locations.map((loc) => ({ id: loc.id, name: loc.name })));
  } catch (err) {
    console.error("Failed to list ServiceTitan inventory locations:", err);
    return NextResponse.json({ error: upstreamFailureError("list Inventory Locations from ServiceTitan") }, { status: 502 });
  }
}
