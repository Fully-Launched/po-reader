// Extensible lookup: invoice-extracted vendor text (as printed on the
// invoice) -> the real ServiceTitan vendor name to search for via
// ServiceTitanClient.findVendorByName().
//
// CONFIRMED bug (live test): the original exact-string-match version failed
// on a real invoice printing "SupplyHouse.com" -- it only matched the exact
// string "supply house" (lowercased/trimmed), so "SupplyHouse.com" (no
// space, ".com" suffix) fell through unmapped and vendor lookup 404'd.
// Fixed by matching on a NORMALIZED (lowercased, punctuation/whitespace
// stripped) alias as a SUBSTRING of the similarly-normalized invoice text,
// not exact equality -- see vendor-name-matching.ts. Each rule lists every
// alias variant seen/expected for that vendor; add more as new invoice
// samples confirm new variants. Kept as a data table, not inline
// if-checks, so this stays easy to extend.
import { matchesAnyAlias } from "./vendor-name-matching";

interface VendorRemapRule {
  serviceTitanVendorName: string;
  aliases: string[];
}

const VENDOR_REMAP_RULES: VendorRemapRule[] = [
  {
    // CONFIRMED on a client call: invoice vendor text "Supply House"
    // resolves to the real ServiceTitan vendor "Chase". "supplyhouse" (no
    // space) covers the real "SupplyHouse.com" variant too, since matching
    // is substring-based on normalized text -- see vendor-name-matching.ts.
    serviceTitanVendorName: "Chase",
    aliases: ["supply house", "supplyhouse"],
  },
  {
    // Per explicit client instruction: map any vendor name containing "TEC"
    // straight to ServiceTitan vendor "TEC" -- NOT independently verified
    // against a live findVendorByName() lookup (blocked on sandbox
    // credential access at the time this was added, see CLAUDE.md Open
    // Questions). If ServiceTitan's real vendor record turns out to be
    // named something else (e.g. "TEC Distribution", "National Excelsior
    // Co." -- the latter wouldn't match this "tec" substring rule at all,
    // a known gap), update serviceTitanVendorName here once confirmed.
    serviceTitanVendorName: "TEC",
    aliases: ["tec"],
  },
];

/**
 * Resolves the invoice's extracted vendor text to the ServiceTitan vendor
 * name to actually search for. Returns the input unchanged when no rule's
 * alias matches -- most vendors (e.g. "Arco Supply Co.") match their real
 * ServiceTitan vendor name directly and need no remapping.
 */
export function resolveServiceTitanVendorName(invoiceVendorName: string): string {
  const rule = VENDOR_REMAP_RULES.find((r) => matchesAnyAlias(invoiceVendorName, r.aliases));
  return rule?.serviceTitanVendorName ?? invoiceVendorName;
}
