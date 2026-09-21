// Per-vendor line-item -> PurchaseOrders_Create items[] strategy.
//
// CONFIRMED on a client call: the naive "match every line item individually
// against the Pricebook, fail if any don't match" strategy (the original
// stopgap -- see CLAUDE.md's pricebook-matching correction) is wrong for two
// of the three vendors. The real strategy depends on which vendor the
// invoice is from:
//
//   - "ARCO SUPPLY CO" and "Supply House" (which remaps to ServiceTitan
//     vendor "Chase" -- see vendor-remap.ts, a SEPARATE concern from this
//     module): consolidate ALL extracted line items into a single PO line,
//     description "Bulk Rough Material," quantity 1, cost = sum of every
//     line item's own total. No per-item Pricebook matching at all for
//     these vendors -- see buildLineItemsForVendor()'s BULK_CONSOLIDATION
//     branch below.
//   - "TEC" (Carrier): keep per-item Pricebook matching for items that DO
//     match; anything that doesn't match is consolidated into a single
//     "Bulk Equipment Material" catch-all line (quantity 1, cost = sum of
//     the unmatched items' totals) instead of blocking submission.
//   - Any other/unrecognized vendor: falls back to the original strict
//     per-item behavior (fail loudly naming every unmatched description).
//     Only 3 vendors exist for this tool (see CLAUDE.md Project Purpose) --
//     extend BULK_CONSOLIDATION_VENDOR_NAMES/CATCH_ALL_VENDOR_NAMES below
//     once the other 2 vendors' real invoice samples confirm their exact
//     vendor-name text and strategy.
//
// Matching is done against the invoice's OWN extracted vendor text (NOT the
// ServiceTitan-resolved vendor from vendor-remap.ts) since that's what's
// actually printed on the document and what determines invoice FORMAT.

import type { InvoiceLineItem } from "../types";
import type { PoLineItem } from "./payload-builder";
import type { ServiceTitanClient } from "./client";
import { notFoundError } from "../error-messages";

export const BULK_ROUGH_MATERIAL_DESCRIPTION = "Bulk Rough Material";
export const BULK_EQUIPMENT_MATERIAL_DESCRIPTION = "Bulk Equipment Material";

const BULK_CONSOLIDATION_VENDOR_NAMES = new Set(["arco supply co", "supply house"]);
const CATCH_ALL_VENDOR_NAMES = new Set(["tec"]);

export type LineItemStrategy = "bulk-consolidation" | "catch-all" | "strict";

export function resolveLineItemStrategy(invoiceVendorName: string): LineItemStrategy {
  const key = invoiceVendorName.trim().toLowerCase();
  if (BULK_CONSOLIDATION_VENDOR_NAMES.has(key)) return "bulk-consolidation";
  if (CATCH_ALL_VENDOR_NAMES.has(key)) return "catch-all";
  return "strict";
}

function sumTotals(items: InvoiceLineItem[]): number {
  return items.reduce((sum, item) => sum + item.total, 0);
}

/**
 * Per-item match counts, for surfacing a "X/Y items matched to Pricebook"
 * indicator in the review table -- NOT applicable to bulk-consolidation
 * (there's no per-item matching to report on), so buildLineItemsForVendor()
 * returns `null` for that strategy rather than an all-zero/misleading
 * summary. "strict" gets one too since it also runs per-item matching, even
 * though its only successful outcome is catchAllCount: 0 (any unmatched item
 * fails the whole call instead of falling into a bucket -- see the strict
 * branch below).
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
    const skuId = await client.findMaterialSkuIdByDescription(BULK_ROUGH_MATERIAL_DESCRIPTION);
    if (skuId === null) {
      return {
        error: notFoundError(
          "Pricebook item",
          BULK_ROUGH_MATERIAL_DESCRIPTION,
          `add "${BULK_ROUGH_MATERIAL_DESCRIPTION}" as a Pricebook Material in ServiceTitan, then try again.`,
          `required for "${invoiceVendorName}" invoices`,
        ),
      };
    }
    return {
      items: [
        {
          skuId,
          description: BULK_ROUGH_MATERIAL_DESCRIPTION,
          vendorPartNumber: "",
          cost: sumTotals(lineItems),
          quantity: 1,
        },
      ],
      matchSummary: null,
    };
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
