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
// not exact equality -- see normalize()/resolveServiceTitanVendorName()
// below. Each rule lists every alias variant seen/expected for that vendor;
// add more as new invoice samples confirm new variants. Kept as a data
// table, not inline if-checks, so this stays easy to extend.
interface VendorRemapRule {
  serviceTitanVendorName: string;
  aliases: string[];
}

const VENDOR_REMAP_RULES: VendorRemapRule[] = [
  {
    // CONFIRMED on a client call: invoice vendor text "Supply House"
    // resolves to the real ServiceTitan vendor "Chase". "supplyhouse" (no
    // space) covers the real "SupplyHouse.com" variant too, since matching
    // is substring-based on normalized text -- see normalize() below.
    serviceTitanVendorName: "Chase",
    aliases: ["supply house", "supplyhouse"],
  },
];

// Lowercases and strips everything except letters/digits, so "SupplyHouse.com",
// "Supply House", and "Supply House, Inc." all normalize to a comparable form
// (e.g. "supplyhousecom", "supplyhouse", "supplyhouseinc") -- letting a
// shorter alias like "supplyhouse" match as a substring of any of them,
// regardless of spacing, punctuation, or suffixes the vendor happens to
// print.
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolves the invoice's extracted vendor text to the ServiceTitan vendor
 * name to actually search for. Returns the input unchanged when no rule's
 * alias matches -- most vendors (e.g. "Arco Supply Co.") match their real
 * ServiceTitan vendor name directly and need no remapping.
 */
export function resolveServiceTitanVendorName(invoiceVendorName: string): string {
  const normalizedInvoiceName = normalize(invoiceVendorName);
  for (const rule of VENDOR_REMAP_RULES) {
    if (rule.aliases.some((alias) => normalizedInvoiceName.includes(normalize(alias)))) {
      return rule.serviceTitanVendorName;
    }
  }
  return invoiceVendorName;
}
