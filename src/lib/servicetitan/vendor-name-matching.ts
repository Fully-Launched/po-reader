// Shared fuzzy-matching helper for invoice-extracted vendor names -- used by
// both vendor-remap.ts (which ServiceTitan vendor to resolve against) and
// line-item-strategy.ts (which line-item strategy to use). Both used to do
// exact-string matching (lowercased/trimmed) independently, and BOTH had the
// same bug: a live invoice printing "SupplyHouse.com" didn't match the exact
// string "supply house", so vendor-remap 404'd on vendor lookup. Fixed there
// first, then the identical bug was spotted in line-item-strategy's
// vendor-name matching too -- consolidated into one shared implementation so
// there's a single place to get this right, not two copies to keep in sync.

// Lowercases and strips everything except letters/digits, so
// "SupplyHouse.com", "Supply House", and "TEC Distribution" all normalize to
// a comparable form (e.g. "supplyhousecom", "supplyhouse", "tecdistribution")
// -- letting a shorter alias like "supplyhouse" or "tec" match as a
// substring of any of them, regardless of spacing, punctuation, or suffixes
// the vendor happens to print.
export function normalizeVendorName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True if any of `aliases` appears as a substring of `vendorName`, after
 * normalizing both (see normalizeVendorName). NOT exact-equality matching --
 * that's the bug this replaced.
 */
export function matchesAnyAlias(vendorName: string, aliases: string[]): boolean {
  const normalized = normalizeVendorName(vendorName);
  return aliases.some((alias) => normalized.includes(normalizeVendorName(alias)));
}
