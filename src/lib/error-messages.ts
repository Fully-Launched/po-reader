// Style guide for every user-facing error message in this app -- API error
// response bodies AND frontend fallback text. Established so future error
// messages are consistent with each other, not each written ad hoc.
//
// Every message should do two things, in order, in one or two sentences:
//   1. State exactly WHAT is wrong, naming the specific value involved (the
//      vendor name, the project number, the file, etc.) -- never a generic
//      "something went wrong."
//   2. State the ACTIONABLE NEXT STEP -- tell the user exactly what to do
//      and where (e.g. "correct the project number in the review table"),
//      not just that something failed. Fold in WHY it's required only if
//      it's not obvious from #1.
//
// Style rules:
//   - Capital first letter, ends with a period.
//   - "--" (not a colon or semicolon) separates the two parts when they
//     don't read naturally as one flowing sentence.
//   - Quote specific values: "Arco Supply Co.", not Arco Supply Co.
//   - NO internal jargon: never mention function/class names, this repo's
//     file names, CLAUDE.md, or ServiceTitan API operation names
//     (PurchaseOrders_Create, etc.) to the end user -- those belong in
//     console.error() logs and code comments, not response bodies.
//
// The reference example this pattern is modeled on (see /api/create-po):
//   `No ServiceTitan job found with Job Number "${projectNumber}". Job
//   attachment is required -- correct the project number in the review
//   table to match an existing ServiceTitan job, or confirm the job exists
//   under a different number.`

/**
 * "No ServiceTitan <resource> found matching <value>" -- the shape shared
 * by every simple name/ID lookup failure (vendor, PO Type, Pricebook item).
 * NOT used for the job lookup, which needs the more specific "Job Number"
 * phrasing (see the reference example above) rather than a generic "matching".
 */
export function notFoundError(resource: string, searchedFor: string, nextStep: string, extraContext?: string): string {
  return `No ServiceTitan ${resource} found matching "${searchedFor}"${extraContext ? ` (${extraContext})` : ""} -- ${nextStep}`;
}

/**
 * Generic upstream-call failure (network error, unexpected non-JSON
 * response, etc.) where there's no more specific detail to report -- used
 * for the handful of "Failed to X" 502s across the API routes.
 */
export function upstreamFailureError(action: string): string {
  return `Failed to ${action}. Try again in a moment, or contact support if this persists.`;
}
