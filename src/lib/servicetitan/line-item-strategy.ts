// Per-vendor line-item -> PurchaseOrders_Create items[] strategy.
//
// CONFIRMED on a client call: the naive "match every line item individually
// against the Pricebook, fail if any don't match" strategy (the original
// stopgap -- see CLAUDE.md's pricebook-matching correction) is wrong for two
// of the three vendors. The real strategy depends on which vendor the
// invoice is from:
//
//   - Arco Supply Co. and "Supply House" (which remaps to ServiceTitan
//     vendor "Chase" -- see vendor-remap.ts, a SEPARATE concern from this
//     module): every extracted line item still produces its OWN PO line,
//     one-to-one -- this is NOT full consolidation. Per-item Pricebook
//     matching is attempted for each item first; an item with no specific
//     match falls back to the generic "Bulk Rough Material" skuId for THAT
//     item alone (its own real description/quantity/cost), not summed with
//     anything else. See buildLineItemsForVendor()'s bulk-consolidation
//     branch below.
//     CORRECTED after a live bug report: an earlier version of this branch
//     collapsed ALL line items into a single PO line (qty 1, cost = sum of
//     everything) regardless of whether individual items would have
//     matched the Pricebook. A real 56-item Arco invoice confirmed this
//     live (PO 2117-002, one $4,411.64 line) -- traced back to a
//     misimplementation of the client-confirmed rule, not something
//     actually confirmed that way on the call. Fixed to always produce
//     one PO line per extracted line item, matching every other vendor's
//     line count; only the SKU an individual unmatched item falls back to
//     is what's specific to this vendor pair, not the line count.
//   - Any vendor name containing "TEC" (which remaps to ServiceTitan vendor
//     "TEC" -- see vendor-remap.ts): keep per-item Pricebook matching for
//     items that DO match; anything that doesn't match is consolidated into
//     a single "Bulk Equipment Material" catch-all line (quantity 1, cost =
//     sum of the unmatched items' totals) instead of blocking submission.
//     Unlike Arco/Supply House above, TEC's unmatched items ARE genuinely
//     meant to consolidate into one catch-all line -- that part of the
//     original design was correct and is unchanged.
//   - Any other/unrecognized vendor: falls back to the original strict
//     per-item behavior (fail loudly naming every unmatched description).
//     Only 3 vendors exist for this tool (see CLAUDE.md Project Purpose) --
//     extend BULK_CONSOLIDATION_VENDOR_ALIASES/CATCH_ALL_VENDOR_ALIASES
//     below once the other 2 vendors' real invoice samples confirm their
//     exact vendor-name text and strategy.
//
// Matching is done against the invoice's OWN extracted vendor text (NOT the
// ServiceTitan-resolved vendor from vendor-remap.ts) since that's what's
// actually printed on the document and what determines invoice FORMAT.

import type { InvoiceLineItem } from "../types";
import type { PoLineItem } from "./payload-builder";
import type { ServiceTitanClient } from "./client";
import { notFoundError } from "../error-messages";
import { matchesAnyAlias } from "./vendor-name-matching";

export const BULK_ROUGH_MATERIAL_DESCRIPTION = "Bulk Rough Material";
export const BULK_EQUIPMENT_MATERIAL_DESCRIPTION = "Bulk Equipment Material";

// Matched via matchesAnyAlias() (normalize + substring, NOT exact equality)
// -- this used to be exact-match Sets, which had the SAME bug fixed in
// vendor-remap.ts: a real invoice's exact printed text (spacing/punctuation/
// suffixes) rarely matches a hand-typed exact string. See
// vendor-name-matching.ts.
const BULK_CONSOLIDATION_VENDOR_ALIASES = ["arco supply co", "supply house", "supplyhouse"];
const CATCH_ALL_VENDOR_ALIASES = ["tec"];

export type LineItemStrategy = "bulk-consolidation" | "catch-all" | "strict";

export function resolveLineItemStrategy(invoiceVendorName: string): LineItemStrategy {
  if (matchesAnyAlias(invoiceVendorName, BULK_CONSOLIDATION_VENDOR_ALIASES)) return "bulk-consolidation";
  if (matchesAnyAlias(invoiceVendorName, CATCH_ALL_VENDOR_ALIASES)) return "catch-all";
  return "strict";
}

function sumTotals(items: InvoiceLineItem[]): number {
  return items.reduce((sum, item) => sum + item.total, 0);
}

/**
 * Per-item match counts, for surfacing a "X/Y items matched to Pricebook"
 * indicator in the review table. `buildLineItemsForVendor()` returns `null`
 * for bulk-consolidation -- NOT because that branch has no per-item
 * matching to report on (it does, as of the per-item-line-items fix, same
 * as catch-all/strict), but because wiring a match-count indicator for it
 * into the review table is a deliberate follow-up, out of scope here. "strict"
 * gets a real summary since it also runs per-item matching, even though its
 * only successful outcome is catchAllCount: 0 (any unmatched item fails the
 * whole call instead of falling into a bucket -- see the strict branch below).
 */
export interface LineItemMatchSummary {
  strategy: "catch-all" | "strict";
  totalItems: number;
  matchedCount: number;
  catchAllCount: number;
}

export type BuildLineItemsResult =
  | { items: PoLineItem[]; matchSummary: LineItemMatchSummary | null }
  | { error: string };

/**
 * Builds the PurchaseOrders_Create items[] array for an invoice according to
 * its vendor's line-item strategy (see file header). Every branch still
 * requires a real Pricebook skuId per ServiceTitan item -- confirmed via a
 * live 400 earlier (see CLAUDE.md) -- so "Bulk Rough Material" and "Bulk
 * Equipment Material" MUST already exist as real Pricebook Material entries
 * in ServiceTitan (Kevin's responsibility to create/maintain, not something
 * this app can create) for the bulk-consolidation/catch-all branches to
 * succeed.
 */
export async function buildLineItemsForVendor(
  client: ServiceTitanClient,
  invoiceVendorName: string,
  lineItems: InvoiceLineItem[],
): Promise<BuildLineItemsResult> {
  const strategy = resolveLineItemStrategy(invoiceVendorName);

  if (strategy === "bulk-consolidation") {
    // One PoLineItem per extracted line item -- NOT collapsed. An item with
    // no specific Pricebook match falls back to the generic "Bulk Rough
    // Material" skuId for that ONE line only, keeping its own real
    // description/quantity/cost; it is never summed with other items. The
    // bulk skuId is looked up at most once (lazily, on the first item that
    // actually needs it), not once per unmatched item.
    const items: PoLineItem[] = [];
    let bulkSkuId: number | null = null;
    for (const item of lineItems) {
      let skuId = await client.findMaterialSkuIdByDescription(item.description);
      if (skuId === null) {
        if (bulkSkuId === null) {
          bulkSkuId = await client.findMaterialSkuIdByDescription(BULK_ROUGH_MATERIAL_DESCRIPTION);
          if (bulkSkuId === null) {
            return {
              error: notFoundError(
                "Pricebook item",
                BULK_ROUGH_MATERIAL_DESCRIPTION,
                `add "${BULK_ROUGH_MATERIAL_DESCRIPTION}" as a Pricebook Material in ServiceTitan, then try again.`,
                `required as a fallback for unmatched line items on "${invoiceVendorName}" invoices`,
              ),
            };
          }
        }
        skuId = bulkSkuId;
      }
      items.push({
        skuId,
        description: item.description,
        vendorPartNumber: item.vendorPartNumber ?? "",
        cost: item.unitPrice,
        quantity: item.quantity,
      });
    }
    // matchSummary intentionally still null here, same as before this fix --
    // this branch now DOES have real per-item match data worth reporting
    // (unlike before, when there was genuinely nothing to report), but
    // wiring that into the review table's "X/Y matched" indicator is left
    // as a deliberate follow-up, out of scope for this line-item-count fix.
    return { items, matchSummary: null };
  }

  if (strategy === "catch-all") {
    const matchedItems: PoLineItem[] = [];
    const unmatchedItems: InvoiceLineItem[] = [];
    for (const item of lineItems) {
      const skuId = await client.findMaterialSkuIdByDescription(item.description);
      if (skuId === null) {
        unmatchedItems.push(item);
      } else {
        matchedItems.push({
          skuId,
          description: item.description,
          vendorPartNumber: item.vendorPartNumber ?? "",
          cost: item.unitPrice,
          quantity: item.quantity,
        });
      }
    }
    if (unmatchedItems.length > 0) {
      const catchAllSkuId = await client.findMaterialSkuIdByDescription(BULK_EQUIPMENT_MATERIAL_DESCRIPTION);
      if (catchAllSkuId === null) {
        return {
          error: notFoundError(
            "Pricebook item",
            BULK_EQUIPMENT_MATERIAL_DESCRIPTION,
            `add "${BULK_EQUIPMENT_MATERIAL_DESCRIPTION}" as a Pricebook Material in ServiceTitan, then try again.`,
            `required to absorb unmatched line items on "${invoiceVendorName}" invoices`,
          ),
        };
      }
      matchedItems.push({
        skuId: catchAllSkuId,
        description: BULK_EQUIPMENT_MATERIAL_DESCRIPTION,
        vendorPartNumber: "",
        cost: sumTotals(unmatchedItems),
        quantity: 1,
      });
    }
    return {
      items: matchedItems,
      matchSummary: {
        strategy: "catch-all",
        totalItems: lineItems.length,
        matchedCount: lineItems.length - unmatchedItems.length,
        catchAllCount: unmatchedItems.length,
      },
    };
  }

  // strict: original behavior, unchanged -- every line item must individually
  // match a Pricebook item, or the whole submission fails naming exactly
  // which descriptions had no match.
  const items: PoLineItem[] = [];
  const unmatchedDescriptions: string[] = [];
  for (const item of lineItems) {
    const skuId = await client.findMaterialSkuIdByDescription(item.description);
    if (skuId === null) {
      unmatchedDescriptions.push(item.description);
    } else {
      items.push({
        skuId,
        description: item.description,
        vendorPartNumber: item.vendorPartNumber ?? "",
        cost: item.unitPrice,
        quantity: item.quantity,
      });
    }
  }
  if (unmatchedDescriptions.length > 0) {
    return {
      error: `Some line items don't match any ServiceTitan Pricebook item: ${unmatchedDescriptions.map((d) => `"${d}"`).join(", ")} -- correct these descriptions in the review table to match existing Pricebook item names, then try again.`,
    };
  }
  return {
    items,
    matchSummary: { strategy: "strict", totalItems: lineItems.length, matchedCount: items.length, catchAllCount: 0 },
  };
}
