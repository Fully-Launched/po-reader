// Extensible lookup: invoice-extracted vendor text (as printed on the
// invoice) -> the real ServiceTitan vendor name to search for via
// ServiceTitanClient.findVendorByName() -- AND, from the same table, a
// short human-friendly display label for the confirmation screens (see
// resolveVendorDisplayName() below). One table, one source of truth for
// both concerns, not two lists that can drift apart.
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
  // Short, human-friendly label for UI display (confirmation screens) --
  // deliberately a SEPARATE concern from serviceTitanVendorName: the latter
  // is what gets searched for via findVendorByName() and must match a real
  // ServiceTitan vendor record exactly, while this is just what reads well
  // to Kevin at a glance (e.g. "Chase (Supply House)" rather than the bare
  // "Chase" the API search actually uses). Same table, same aliases --
  // ONE source of truth for both concerns, not a parallel list.
  displayName: string;
  aliases: string[];
}

const VENDOR_REMAP_RULES: VendorRemapRule[] = [
  {
    // CONFIRMED on a client call: invoice vendor text "Supply House"
    // resolves to the real ServiceTitan vendor "Chase". "supplyhouse" (no
    // space) covers the real "SupplyHouse.com" variant too, since matching
    // is substring-based on normalized text -- see vendor-name-matching.ts.
    serviceTitanVendorName: "Chase",
    displayName: "Chase (Supply House)",
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
    displayName: "TEC",
    aliases: ["tec"],
  },
  {
    // Arco Supply Co's invoice text already matches its real ServiceTitan
    // vendor name directly (no remapping needed for API resolution -- this
    // rule resolves to the exact same string a missing rule would have
    // passed through unchanged). Added here purely so it has a table entry
    // to hang a display name off of, keeping this ONE table the single
    // source of truth for every vendor's display label, not just the two
    // that also happen to need real remapping.
    serviceTitanVendorName: "Arco Supply Co",
    displayName: "Arco Supply",
    aliases: ["arco supply co"],
  },
];

/**
 * Resolves the invoice's extracted vendor text to the ServiceTitan vendor
 * name to actually search for. Returns the input unchanged when no rule's
 * alias matches.
 */
export function resolveServiceTitanVendorName(invoiceVendorName: string): string {
  const rule = VENDOR_REMAP_RULES.find((r) => matchesAnyAlias(invoiceVendorName, r.aliases));
  return rule?.serviceTitanVendorName ?? invoiceVendorName;
}

/**
 * Resolves the invoice's extracted vendor text to a short, human-friendly
 * display label for the confirmation screens (e.g. "Chase (Supply House)"
 * for a "SupplyHouse.com" invoice) -- SAME table/aliases as
 * resolveServiceTitanVendorName() above, not a separate parallel list, so
 * the two can't drift out of sync. Returns the raw invoice vendor text
 * unchanged when no rule matches (an unrecognized/typo'd vendor), same
 * fallback behavior as the API-resolution function.
 */
export function resolveVendorDisplayName(invoiceVendorName: string): string {
  const rule = VENDOR_REMAP_RULES.find((r) => matchesAnyAlias(invoiceVendorName, r.aliases));
  return rule?.displayName ?? invoiceVendorName;
}
