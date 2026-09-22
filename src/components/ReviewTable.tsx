"use client";

import { useEffect, useState } from "react";
import type { ExtractedInvoice, InvoiceLineItem } from "@/lib/types";
import { reviewWarnings, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";

/**
 * A submission failure from /api/create-po. `field`, when the API named a
 * specific input as the cause (see error-messages.ts's style guide and
 * route.ts's ReviewTableField), lets this screen put a red border on that
 * exact field instead of only showing the message in the banner below.
 */
export interface SubmitError {
  message: string;
  field?: "vendorName" | "projectNumber";
}

export interface ReviewTableProps {
  invoice: ExtractedInvoice;
  // Source-document side panel (filename + page count) shown alongside the
  // form, ported from po-generator-draft.html's doc-panel. pageCount is
  // null when it genuinely isn't known (shouldn't normally happen -- both
  // call sites in InvoiceUploader.tsx derive it from the detected invoice
  // boundary -- but rendered as "--" rather than a false "0 pages" if it is).
  docInfo: { filename: string; pageCount: number | null };
  onConfirm: (
    invoice: ExtractedInvoice,
    businessUnitId: number,
    inventoryLocationId: number,
    requiredOn: string,
  ) => void;
  onCancel: () => void;
  // Label for the "not a vendor invoice" hard-block screen's button (see
  // isNotAnInvoice below). Defaults to the single-invoice-upload wording;
  // the multi-invoice batch flow (InvoiceUploader.tsx's BatchInvoiceScreen)
  // overrides it to "Skip this invoice" since onCancel there advances the
  // bundle rather than returning to the file picker.
  cancelLabel?: string;
  submitting: boolean;
  submitError: SubmitError | null;
}

interface LineItemMatchSummary {
  strategy: "catch-all" | "strict";
  totalItems: number;
  matchedCount: number;
  catchAllCount: number;
}

// Today's date (YYYY-MM-DD) in the browser's local timezone -- requiredOn's
// default. Deliberately NOT `new Date().toISOString()` (UTC), which can read
// as the wrong day near local midnight.
function todayLocalDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Live math reconciliation, ported from po-generator-draft.html's
// runAccuracyCheck -- recomputed from the current draft on every render
// (cheap: a couple of sums over at most a few dozen line items), not
// memoized or debounced. Distinct from reviewWarnings() (per-line-item
// extraction-confidence flags): this is purely arithmetic and doesn't know
// or care whether a value was extracted or hand-typed.
//
// WARNING ONLY -- deliberately does NOT gate submission. Unlike the
// mockup (which disabled its submit button on any issue here), a
// subtotal/total mismatch is often legitimate (e.g. freight or a
// vendor-applied discount not broken out per line) and the user may have
// already reviewed and confirmed it's fine. hasRequiredFields() below is
// the only real submission gate.
function computeAccuracyIssues(invoice: ExtractedInvoice): string[] {
  const issues: string[] = [];

  const lineSum = invoice.lineItems.reduce((sum, item) => sum + item.total, 0);
  const lineDiff = Math.round((lineSum - invoice.subtotal) * 100) / 100;
  if (Math.abs(lineDiff) > 0.01) {
    issues.push(
      `Line items sum to $${lineSum.toFixed(2)}, but subtotal shows $${invoice.subtotal.toFixed(2)} (off by $${Math.abs(lineDiff).toFixed(2)})`,
    );
  }

  const tax = invoice.taxAmount ?? 0;
  const totalDiff = Math.round((invoice.subtotal + tax - invoice.total) * 100) / 100;
  if (Math.abs(totalDiff) > 0.01) {
    issues.push(
      `Subtotal + tax = $${(invoice.subtotal + tax).toFixed(2)}, but total shows $${invoice.total.toFixed(2)} (off by $${Math.abs(totalDiff).toFixed(2)})`,
    );
  }

  return issues;
}

// Splits a message into a bold "what's wrong" lead sentence and a non-bold
// "what to do about it" remainder, per error-messages.ts's own two-part
// style guide (state what's wrong, then the actionable next step). Used to
// restructure submitError.message -- server-generated, real content, not
// hardcoded -- into the bold/non-bold banner format below without losing
// any of it. Falls back to treating the whole message as the lead if it
// doesn't contain a natural sentence break.
function splitBannerLead(message: string): { lead: string; rest: string } {
  const match = message.match(/^([\s\S]*?[.!?])\s+([\s\S]*)$/);
  return match ? { lead: match[1], rest: match[2] } : { lead: message, rest: "" };
}

// Generic loader for the Business Unit / Inventory Location dropdowns --
// both follow the identical fetch-on-mount / loading / error / empty /
// auto-select-single-option pattern, just against different endpoints.
// An optional defaultName pre-selects a preferred option by name when
// present (e.g. Business Unit defaulting to "HVAC Service") -- the
// dropdown still renders fully editable either way.
function useIdNameOptions(url: string, resourceLabel: string, defaultName?: string) {
  const [options, setOptions] = useState<{ id: number; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            (await res.json().catch(() => ({}))).error ??
              `Failed to load ${resourceLabel} (${res.status}) -- try again in a moment, or contact support if this persists.`,
          );
        }
        return res.json() as Promise<{ id: number; name: string }[]>;
      })
      .then((result) => {
        if (cancelled) return;
        setOptions(result);
        // Only one option -- pre-select it so the user doesn't have to act,
        // but it still renders in the dropdown rather than being hidden.
        if (result.length === 1) {
          setSelectedId(String(result[0].id));
        } else if (defaultName) {
          const preferred = result.find((option) => option.name === defaultName);
          if (preferred) {
            setSelectedId(String(preferred.id));
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : `Failed to load ${resourceLabel} -- try again in a moment, or contact support if this persists.`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [url, resourceLabel, defaultName]);

  return { options, error, selectedId, setSelectedId };
}

interface IdNameSelectProps {
  label: string;
  options: { id: number; name: string }[] | null;
  error: string | null;
  selectedId: string;
  onChange: (value: string) => void;
  emptyMessage: string;
  disabled: boolean;
}

// Shared rendering for the Business Unit / Inventory Location dropdowns:
// loading / error / empty / normal states, all backed by useIdNameOptions
// above. The user always picks a name from this dropdown -- never sees or
// types a raw ID. Not part of the original po-generator-draft.html mockup
// (which didn't model these fields) -- styled to match its input/label
// conventions.
function IdNameSelect({ label, options, error, selectedId, onChange, emptyMessage, disabled }: IdNameSelectProps) {
  return (
    <div>
      <label>{label}</label>
      {error ? (
        <p role="alert" style={{ fontSize: 12, color: "var(--red-text)" }}>
          Couldn&apos;t load: {error}
        </p>
      ) : options === null ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</p>
      ) : options.length === 0 ? (
        <p role="alert" style={{ fontSize: 12, color: "var(--red-text)" }}>
          {emptyMessage}
        </p>
      ) : (
        <select value={selectedId} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {options.length > 1 && (
            <option value="" disabled>
              Select {label.toLowerCase()}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const EMPTY_LINE_ITEM: InvoiceLineItem = {
  description: "",
  quantity: 1,
  unitPrice: 0,
  total: 0,
  vendorPartNumber: null,
  lowConfidence: false,
};
const VISIBLE_LINE_ITEM_LIMIT = 3; // matches the "+N more line items" treatment in the mockup

// "Review invoice" screen shown between extraction and submission. This is
// the human-in-the-loop checkpoint: nothing is sent to ServiceTitan until
// the user confirms the data here. Layout ported from po-generator-draft.html
// (design mockup) -- vendor/invoice-# card, line-items card, totals card,
// then (added, not in the mockup) Business Unit / Inventory Location
// dropdowns since those are real required fields for PurchaseOrders_Create.
//
// Extraction is treated as a starting draft, not a pass/fail gate: low
// confidence or missing fields show a non-blocking banner -- the user fills
// in or corrects whatever's wrong, including fields the extraction got
// wrong or missed entirely (see reviewWarnings/hasRequiredFields in
// src/lib/servicetitan/payload-builder.ts). The one exception is a document
// that isn't an invoice at all (e.g. an internal memo) -- there's no
// partial data worth editing, so that case hard-blocks below.
export function ReviewTable({ invoice, docInfo, onConfirm, onCancel, cancelLabel, submitting, submitError }: ReviewTableProps) {
  const [draft, setDraft] = useState<ExtractedInvoice>(invoice);
  const [showAllLineItems, setShowAllLineItems] = useState(false);
  // Defaults to today but is genuinely editable, including backdating --
  // confirmed with the client as a real requirement, not just a display
  // value. Plain <input type="date"> imposes no min/max, so past dates are
  // selectable.
  const [requiredOn, setRequiredOn] = useState(todayLocalDate);
  const businessUnit = useIdNameOptions("/api/business-units", "Business Units", "HVAC Service");
  const inventoryLocation = useIdNameOptions("/api/inventory-locations", "Inventory Locations");

  // Pricebook match-count preview for the "X/Y items matched to Pricebook"
  // indicator below -- calls /api/line-item-match-preview, which runs the
  // SAME buildLineItemsForVendor() logic /api/create-po uses at submission
  // time, just to surface counts rather than create a PO. Only meaningful
  // for vendors whose strategy runs per-item matching (catch-all/strict) --
  // matchSummary comes back null for bulk-consolidation vendors, and is
  // rendered as "strategy === catch-all" only (see below) since "strict"'s
  // only successful outcome is a trivial all-matched case with nothing
  // useful to report.
  const [matchSummary, setMatchSummary] = useState<LineItemMatchSummary | null>(null);
  const [matchSummaryLoading, setMatchSummaryLoading] = useState(false);
  const [matchSummaryError, setMatchSummaryError] = useState<string | null>(null);

  async function checkLineItemMatches(vendorName: string, lineItems: InvoiceLineItem[]) {
    setMatchSummaryLoading(true);
    setMatchSummaryError(null);
    try {
      const res = await fetch("/api/line-item-match-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorName, lineItems }),
      });
      const resBody = await res.json();
      if (!res.ok) {
        throw new Error(resBody.error ?? `Failed to check Pricebook matches (${res.status}) -- try again in a moment, or contact support if this persists.`);
      }
      setMatchSummary(resBody.matchSummary ?? null);
      if (!resBody.matchSummary && resBody.error) {
        setMatchSummaryError(resBody.error);
      }
    } catch (err) {
      setMatchSummaryError(
        err instanceof Error
          ? err.message
          : "Failed to check Pricebook matches -- try again in a moment, or contact support if this persists.",
      );
    } finally {
      setMatchSummaryLoading(false);
    }
  }

  // Runs once against the as-extracted data on mount -- a manual "Recheck"
  // button (rendered below) re-runs it against the user's current edits,
  // rather than re-fetching on every keystroke (expensive: one Pricebook
  // lookup per line item).
  useEffect(() => {
    checkLineItemMatches(invoice.vendorName, invoice.lineItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactive invalidation of a server-side submission error, once the user
  // edits the specific field it named -- previously the red banner/border
  // persisted until the next submit attempt actually re-validated it, even
  // after a plausible-looking correction. Snapshots that field's value at
  // the moment the error arrives (this effect only re-runs when the
  // submitError PROP changes, not on every keystroke), then every render
  // compares the current draft value against that snapshot; once they
  // differ, the error is treated as resolved for display purposes without
  // waiting on another round-trip. An error with no `field` (a generic
  // network/upstream failure -- nothing specific to react to) can't be
  // invalidated this way and still persists until the next submit, same as
  // before.
  const [erroredFieldSnapshot, setErroredFieldSnapshot] = useState<
    { field: "vendorName" | "projectNumber"; value: string } | null
  >(null);
  useEffect(() => {
    if (submitError?.field === "vendorName") {
      setErroredFieldSnapshot({ field: "vendorName", value: draft.vendorName });
    } else if (submitError?.field === "projectNumber") {
      setErroredFieldSnapshot({ field: "projectNumber", value: draft.projectNumber ?? "" });
    } else {
      setErroredFieldSnapshot(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitError]);
  const submitErrorResolved =
    erroredFieldSnapshot !== null &&
    submitError?.field === erroredFieldSnapshot.field &&
    (erroredFieldSnapshot.field === "vendorName" ? draft.vendorName : draft.projectNumber ?? "") !==
      erroredFieldSnapshot.value;
  const effectiveSubmitError = submitErrorResolved ? null : submitError;

  if (isNotAnInvoice(draft)) {
    return (
      <div className="confirm-wrap">
        <div className="confirm-icon" style={{ background: "var(--red-bg)" }}>
          <i className="ti ti-file-off" style={{ color: "var(--red-text)" }} />
        </div>
        <div className="confirm-title">Not a vendor invoice</div>
        <div className="confirm-sub">
          This document doesn&apos;t appear to be a vendor invoice{draft.notes ? ` -- ${draft.notes}` : ""}, so
          there&apos;s nothing to review or submit.
        </div>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {cancelLabel ?? "Choose a different file"}
        </button>
      </div>
    );
  }

  const warnings = reviewWarnings(draft);
  const accuracyIssues = computeAccuracyIssues(draft);
  const idFilled = (id: string) => id.trim() !== "" && !Number.isNaN(Number(id));
  const canSubmit =
    !submitting &&
    hasRequiredFields(draft) &&
    idFilled(businessUnit.selectedId) &&
    idFilled(inventoryLocation.selectedId) &&
    requiredOn.trim() !== "";

  // Proactive red-border state, mirroring hasRequiredFields()'s checks --
  // shown as soon as the screen loads with a required field empty, not only
  // after a failed submission attempt. `effectiveSubmitError?.field` is ALSO
  // checked here (not just the empty-value case) since a server-side
  // failure can fire on a NON-empty value the client can't validate itself
  // (e.g. a vendor name that's present but doesn't match any ServiceTitan
  // vendor, or a project number that's present but matches no job) --
  // `effectiveSubmitError` (not the raw prop) so this clears the moment the
  // user edits the named field, not only on the next submit attempt.
  const vendorNameInvalid = !draft.vendorName.trim() || effectiveSubmitError?.field === "vendorName";
  const projectNumberInvalid = !draft.projectNumber?.trim() || effectiveSubmitError?.field === "projectNumber";
  const invalidFieldStyle = (invalid: boolean) => (invalid ? { borderColor: "var(--red-text)" } : undefined);

  function updateField<K extends keyof ExtractedInvoice>(key: K, value: ExtractedInvoice[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function updateLineItem<K extends keyof InvoiceLineItem>(index: number, key: K, value: InvoiceLineItem[K]) {
    setDraft((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((item, i) => {
        if (i !== index) return item;
        const updated = { ...item, [key]: value };
        // Auto-recalculate this row's Total from Qty x Price whenever
        // either changes -- ported from po-generator-draft.html's
        // recalcLineTotal. Editing Total directly still works (it's just
        // not protected from being overwritten by a later qty/price edit,
        // same as the mockup).
        if (key === "quantity" || key === "unitPrice") {
          updated.total = Math.round(updated.quantity * updated.unitPrice * 100) / 100;
        }
        return updated;
      }),
    }));
  }

  function addLineItem() {
    setDraft((prev) => ({ ...prev, lineItems: [...prev.lineItems, { ...EMPTY_LINE_ITEM }] }));
    setShowAllLineItems(true);
  }

  function removeLineItem(index: number) {
    setDraft((prev) => ({ ...prev, lineItems: prev.lineItems.filter((_, i) => i !== index) }));
  }

  const visibleLineItems =
    showAllLineItems ? draft.lineItems : draft.lineItems.slice(0, VISIBLE_LINE_ITEM_LIMIT);
  const hiddenCount = draft.lineItems.length - visibleLineItems.length;

  return (
    <div className="screen">
      {/* Two-pane layout ported from po-generator-draft.html's doc-panel --
          shows what's actually being reviewed (filename, page count within
          the source PDF, extraction status) alongside the form, and fills
          the available width better than a single narrow centered card. */}
      <div className="review-layout">
        <div className="doc-panel">
          <div className="section-label" style={{ marginBottom: 0 }}>
            Source document
          </div>
          <div className="doc-preview">
            <i className="ti ti-file-invoice" />
            <div className="fname">{docInfo.filename}</div>
            <div className="fmeta">
              {docInfo.pageCount != null ? `${docInfo.pageCount} page${docInfo.pageCount === 1 ? "" : "s"}` : "--"}
            </div>
          </div>
          <div className="doc-status">
            <i className="ti ti-check" />
            Read by Claude
          </div>
        </div>

        <div className="review-form">
          <div className="card grid-2">
            <div>
              <label>Vendor name</label>
              <input
                className="mono"
                placeholder="Enter vendor name"
                value={draft.vendorName}
                onChange={(e) => updateField("vendorName", e.target.value)}
                aria-invalid={vendorNameInvalid}
                style={invalidFieldStyle(vendorNameInvalid)}
              />
            </div>
            <div>
              <label>Invoice #</label>
              <input
                className="mono"
                placeholder="Invoice number"
                value={draft.invoiceNumber}
                onChange={(e) => updateField("invoiceNumber", e.target.value)}
              />
            </div>
            <div>
              <label>Invoice date</label>
              <input
                className="mono"
                placeholder="YYYY-MM-DD"
                value={draft.invoiceDate}
                onChange={(e) => updateField("invoiceDate", e.target.value)}
              />
            </div>
            <div>
              <label>Project / job number</label>
              <input
                className="mono"
                placeholder="Required -- must match an existing ServiceTitan job"
                value={draft.projectNumber ?? ""}
                onChange={(e) => updateField("projectNumber", e.target.value.trim() === "" ? null : e.target.value)}
                aria-invalid={projectNumberInvalid}
                style={invalidFieldStyle(projectNumberInvalid)}
              />
            </div>
          </div>
    
          <div className="card">
            <div className="section-label">Line items &middot; {draft.lineItems.length} total</div>
            <div className="line-item-head">
              <span>Description</span>
              <span>Vendor part #</span>
              <span>Qty</span>
              <span>Unit price</span>
              <span>Total</span>
              <span></span>
            </div>
            {visibleLineItems.map((item) => {
              const i = draft.lineItems.indexOf(item);
              return (
                <div
                  className="line-item-row"
                  key={i}
                  // Per-item low-confidence flag from extraction (distinct from
                  // the whole-document extractionConfidence banner) -- amber
                  // left border puts the user's eye on exactly which row to
                  // double-check against the source PDF, not just a generic
                  // warning banner with no row-level indication.
                  style={item.lowConfidence ? { borderLeft: "3px solid var(--amber-text)", paddingLeft: 6 } : undefined}
                  title={item.lowConfidence ? "Low extraction confidence -- verify against the original PDF" : undefined}
                >
                  <input
                    placeholder="Item description"
                    value={item.description}
                    onChange={(e) => updateLineItem(i, "description", e.target.value)}
                    aria-invalid={!item.description.trim()}
                    style={invalidFieldStyle(!item.description.trim())}
                  />
                  <input
                    placeholder="If any"
                    value={item.vendorPartNumber ?? ""}
                    onChange={(e) => updateLineItem(i, "vendorPartNumber", e.target.value.trim() === "" ? null : e.target.value)}
                  />
                  <input
                    className="mono"
                    type="number"
                    value={item.quantity}
                    onChange={(e) => updateLineItem(i, "quantity", Number(e.target.value))}
                    aria-invalid={item.quantity <= 0}
                    style={invalidFieldStyle(item.quantity <= 0)}
                  />
                  <input
                    className="mono"
                    type="number"
                    value={item.unitPrice}
                    onChange={(e) => updateLineItem(i, "unitPrice", Number(e.target.value))}
                  />
                  <input
                    className="mono"
                    type="number"
                    value={item.total}
                    onChange={(e) => updateLineItem(i, "total", Number(e.target.value))}
                  />
                  <button type="button" className="btn-ghost" onClick={() => removeLineItem(i)}>
                    Remove
                  </button>
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <div className="more-items">
                <button type="button" className="btn-ghost" onClick={() => setShowAllLineItems(true)}>
                  + {hiddenCount} more line item{hiddenCount === 1 ? "" : "s"}
                </button>
              </div>
            )}
            <button type="button" className="btn-add" onClick={addLineItem}>
              Add line item
            </button>
    
            {/* Pricebook match-count indicator -- only meaningful for vendors whose
                strategy actually runs per-item matching against the Pricebook
                (TEC-style catch-all). Bulk-consolidation vendors (Arco/Supply House)
                always collapse into one line, so matchSummary is null there and
                nothing renders; "strict"-strategy matchSummary is also suppressed
                here since its only successful outcome is a trivial all-matched
                case with no "added to bulk material" line to report. */}
            {matchSummaryLoading && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>Checking Pricebook matches...</p>
            )}
            {!matchSummaryLoading && matchSummary?.strategy === "catch-all" && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
                {matchSummary.matchedCount}/{matchSummary.totalItems} items matched to Pricebook,{" "}
                {matchSummary.catchAllCount}/{matchSummary.totalItems} added to bulk material
                {" -- "}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: 0 }}
                  onClick={() => checkLineItemMatches(draft.vendorName, draft.lineItems)}
                >
                  Recheck
                </button>
              </p>
            )}
            {!matchSummaryLoading && matchSummaryError && (
              <p role="alert" style={{ fontSize: 12, color: "var(--red-text)", marginTop: 10 }}>
                Couldn&apos;t check Pricebook matches: {matchSummaryError}
              </p>
            )}
          </div>
    
          <div className="card grid-2">
            <div>
              <label>Subtotal</label>
              <input
                className="mono"
                type="number"
                value={draft.subtotal}
                onChange={(e) => updateField("subtotal", Number(e.target.value))}
              />
            </div>
            <div>
              <label>Tax</label>
              <input
                className="mono"
                type="number"
                placeholder="n/a"
                value={draft.taxAmount ?? ""}
                onChange={(e) => updateField("taxAmount", e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
            <div>
              <label>Total</label>
              <input
                className="mono"
                type="number"
                style={{ fontWeight: 500 }}
                value={draft.total}
                onChange={(e) => updateField("total", Number(e.target.value))}
              />
            </div>
            <div>
              <label>Freight / shipping</label>
              <input
                className="mono"
                type="number"
                placeholder="0.00"
                value={draft.freightAmount ?? ""}
                onChange={(e) => updateField("freightAmount", e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
          </div>
    
          {/* Status banner A -- submission status + live math reconciliation
              ONLY, prioritized red (submission error) > yellow (numbers
              don't reconcile) > green. Deliberately does NOT include
              extraction-confidence content (per-item lowConfidence
              warnings, draft.notes) -- an earlier version folded those in
              here too, which meant unrelated notes (page count, footer
              references, freight breakdowns, etc.) showed up underneath a
              banner that was supposed to be purely about the subtotal/total
              math. That content has its own separate banner B below instead
              of being dropped. WARNING ONLY when yellow -- still never
              disables the submit button; only hasRequiredFields() (via
              canSubmit below) gates submission. */}
          {effectiveSubmitError ? (
            (() => {
              const { lead, rest } = splitBannerLead(effectiveSubmitError.message);
              return (
                <div className="banner banner-error">
                  <i className="ti ti-alert-circle" />
                  <div>
                    <strong>{lead}</strong>
                    {rest && <> {rest}</>}
                  </div>
                </div>
              );
            })()
          ) : accuracyIssues.length > 0 ? (
            <div className="banner banner-warning">
              <i className="ti ti-alert-triangle" />
              <div>
                <strong>Numbers don&apos;t reconcile</strong>{" "}
                {accuracyIssues.length === 1 ? (
                  accuracyIssues[0]
                ) : (
                  <ul>
                    {accuracyIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="banner banner-success">
              <i className="ti ti-shield-check" />
              <div>
                <strong>Accuracy check passed:</strong> No issues flagged.
              </div>
            </div>
          )}

          {/* Status banner B -- extraction-confidence notes: which specific
              line items Claude itself wasn't confident about
              (InvoiceLineItem.lowConfidence, surfaced via reviewWarnings()),
              plus any general extraction notes (page count, footer/field
              sourcing, freight or misc-charge breakdowns, etc.). SEPARATE
              from banner A above on purpose -- this is about extraction
              quality, not submission status or arithmetic. Renders only
              when there's actually something to say (no matching "all
              clear" green state here -- banner A already covers that,
              showing a second green banner here would reintroduce the
              duplicate-banner problem this screen already had once). */}
          {(warnings.length > 0 || draft.notes.trim()) && (
            <div className="banner banner-warning">
              <i className="ti ti-alert-triangle" />
              <div>
                {warnings.length > 0 && (
                  <>
                    <strong>Flagged for review</strong> -- please check before submitting:
                    <ul>
                      {warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </>
                )}
                {draft.notes.trim() && <div>{draft.notes}</div>}
              </div>
            </div>
          )}

          <div className="card grid-3">
            <IdNameSelect
              label="Business Unit"
              options={businessUnit.options}
              error={businessUnit.error}
              selectedId={businessUnit.selectedId}
              onChange={businessUnit.setSelectedId}
              emptyMessage="No business units found for this tenant."
              disabled={submitting}
            />
            <IdNameSelect
              label="Inventory Location"
              options={inventoryLocation.options}
              error={inventoryLocation.error}
              selectedId={inventoryLocation.selectedId}
              onChange={inventoryLocation.setSelectedId}
              emptyMessage="No inventory locations found for this tenant."
              disabled={submitting}
            />
            <div>
              <label>Required on</label>
              {/* No min attribute -- confirmed with the client this needs to
                  allow backdating, not just today/future dates. */}
              <input
                className="mono"
                type="date"
                value={requiredOn}
                onChange={(e) => setRequiredOn(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
    
          <button
            type="button"
            className="btn-primary"
            disabled={!canSubmit}
            onClick={() =>
              onConfirm(draft, Number(businessUnit.selectedId), Number(inventoryLocation.selectedId), requiredOn)
            }
          >
            {submitting ? "Creating purchase order..." : "Create purchase order"}
          </button>
        </div>
      </div>
    </div>
  );
}
