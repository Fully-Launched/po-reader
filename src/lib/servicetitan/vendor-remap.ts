// Simple, extensible lookup: invoice-extracted vendor text (as printed on
// the invoice, matched case-insensitively) -> the real ServiceTitan vendor
// name to search for via ServiceTitanClient.findVendorByName().
//
// CONFIRMED on a client call: when the invoice vendor text is "Supply
// House," the actual ServiceTitan vendor to resolve against is "Chase." A
// table (not an inline if-check) since more vendor aliases are expected as
// the other 2 non-integrated vendors' real invoice samples come in -- see
// CLAUDE.md's "Business logic" section.
const VENDOR_REMAP: Record<string, string> = {
  "supply house": "Chase",
};

/**
 * Resolves the invoice's extracted vendor text to the ServiceTitan vendor
 * name to actually search for. Returns the input unchanged when there's no
 * remap entry -- most vendors (e.g. "Arco Supply Co.") match their real
 * ServiceTitan vendor name directly and need no remapping.
 */
export function resolveServiceTitanVendorName(invoiceVendorName: string): string {
  const remapped = VENDOR_REMAP[invoiceVendorName.trim().toLowerCase()];
  return remapped ?? invoiceVendorName;
}
