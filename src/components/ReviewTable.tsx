"use client";

import { useEffect, useState } from "react";
import type { ExtractedInvoice, InvoiceLineItem } from "@/lib/types";
import { reviewWarnings, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";

interface ReviewTableProps {
  invoice: ExtractedInvoice;
  onConfirm: (invoice: ExtractedInvoice, businessUnitId: number, inventoryLocationId: number) => void;
  onCancel: () => void;
  submitting: boolean;
  submitError: string | null;
}

// Generic loader for the Business Unit / Inventory Location dropdowns --
// both follow the identical fetch-on-mount / loading / error / empty /
// auto-select-single-option pattern, just against different endpoints.
function useIdNameOptions(url: string) {
  const [options, setOptions] = useState<{ id: number; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`);
        return res.json() as Promise<{ id: number; name: string }[]>;
      })
      .then((result) => {
        if (cancelled) return;
        setOptions(result);
        // Only one option -- pre-select it so the user doesn't have to act,
        // but it still renders in the dropdown rather than being hidden.
        if (result.length === 1) {
          setSelectedId(String(result[0].id));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : `Failed to load from ${url}`);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

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

const EMPTY_LINE_ITEM: InvoiceLineItem = { description: "", quantity: 1, unitPrice: 0, total: 0, vendorPartNumber: null };
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
export function ReviewTable({ invoice, onConfirm, onCancel, submitting, submitError }: ReviewTableProps) {
  const [draft, setDraft] = useState<ExtractedInvoice>(invoice);
  const [showAllLineItems, setShowAllLineItems] = useState(false);
  const businessUnit = useIdNameOptions("/api/business-units");
  const inventoryLocation = useIdNameOptions("/api/inventory-locations");

  if (isNotAnInvoice(draft)) {
    return (
      <div className="confirm-wrap">
        <div className="confirm-icon" style={{ background: "var(--red-bg)" }}>
          <i className="ti ti-file-off" style={{ color: "var(--red-text)" }} />
        </div>
        <div className="confirm-title">Not a vendor invoice</div>
        <div className="confirm-sub">
          This document doesn&apos;t appear to be a vendor invoice{draft.notes ? ` -- ${draft.notes}` : ""}. There&apos;s
          nothing to review or submit.
        </div>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Choose a different file
        </button>
      </div>
    );
  }

  const warnings = reviewWarnings(draft);
  const idFilled = (id: string) => id.trim() !== "" && !Number.isNaN(Number(id));
  const canSubmit =
    !submitting &&
    hasRequiredFields(draft) &&
    idFilled(businessUnit.selectedId) &&
    idFilled(inventoryLocation.selectedId);

  function updateField<K extends keyof ExtractedInvoice>(key: K, value: ExtractedInvoice[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function updateLineItem<K extends keyof InvoiceLineItem>(index: number, key: K, value: InvoiceLineItem[K]) {
    setDraft((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
    }));
  }

  function addLineItem() {
    setDraft((prev) => ({ ...prev, lineItems: [...prev.lineItems, { ...EMPTY_LINE_ITEM }] }));
    setShowAllLineItems(true);
  }

  function removeLineItem(index: number) {
    setDraft((prev) => ({ ...prev, lineItems: prev.lineItems.filter((_, i) => i !== index) }));
  }

  // TODO: recompute subtotal/total automatically as line items are edited --
  // currently these are direct editable fields, matching what the user typed
  // rather than a derived value.

  const visibleLineItems =
    showAllLineItems ? draft.lineItems : draft.lineItems.slice(0, VISIBLE_LINE_ITEM_LIMIT);
  const hiddenCount = draft.lineItems.length - visibleLineItems.length;

  return (
    <div className="screen">
      <div className="card grid-2">
        <div>
          <label>Vendor name</label>
          <input
            className="mono"
            placeholder="Enter vendor name"
            value={draft.vendorName}
            onChange={(e) => updateField("vendorName", e.target.value)}
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
          <label>Project / job number (optional)</label>
          <input
            className="mono"
            placeholder="Leave blank for bulk/inventory purchases"
            value={draft.projectNumber ?? ""}
            onChange={(e) => updateField("projectNumber", e.target.value.trim() === "" ? null : e.target.value)}
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
            <div className="line-item-row" key={i}>
              <input
                placeholder="Item description"
                value={item.description}
                onChange={(e) => updateLineItem(i, "description", e.target.value)}
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
      </div>

      <div className="card grid-3">
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
      </div>

      {warnings.length === 0 ? (
        <div className="banner banner-success">
          <i className="ti ti-shield-check" />
          Accuracy check passed -- no issues flagged
        </div>
      ) : (
        <div className="banner banner-warning">
          <i className="ti ti-alert-triangle" />
          <div>
            Flagged for review -- please check before submitting:
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            {draft.notes && <div>{draft.notes}</div>}
          </div>
        </div>
      )}

      <div className="card grid-2">
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
      </div>

      {submitError && (
        <div className="banner banner-error">
          <i className="ti ti-alert-circle" />
          {submitError}
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        disabled={!canSubmit}
        onClick={() => onConfirm(draft, Number(businessUnit.selectedId), Number(inventoryLocation.selectedId))}
      >
        {submitting ? "Creating purchase order..." : "Create purchase order"}
      </button>
    </div>
  );
}
