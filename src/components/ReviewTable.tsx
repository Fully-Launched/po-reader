"use client";

import { useEffect, useState } from "react";
import type { ExtractedInvoice, InvoiceLineItem } from "@/lib/types";
import { reviewWarnings, hasRequiredFields, isNotAnInvoice } from "@/lib/servicetitan/payload-builder";

interface ReviewTableProps {
  invoice: ExtractedInvoice;
  onConfirm: (invoice: ExtractedInvoice, businessUnitId: number) => void;
  onCancel: () => void;
}

interface BusinessUnit {
  id: number;
  name: string;
}

const EMPTY_LINE_ITEM: InvoiceLineItem = { description: "", quantity: 1, unitPrice: 0, total: 0 };

// Editable table shown between extraction and submission. This is the
// human-in-the-loop checkpoint: nothing is sent to ServiceTitan until the
// user confirms the data in this table.
//
// Extraction is treated as a starting draft, not a pass/fail gate: low
// confidence or missing fields show a warning banner but never disable the
// form -- the user fills in or corrects whatever's wrong, including fields
// the extraction got wrong or missed entirely (see reviewWarnings /
// hasRequiredFields in src/lib/servicetitan/payload-builder.ts). The one
// exception is a document that isn't an invoice at all (e.g. an internal
// memo) -- there's no partial data worth editing, so that case still hard
// blocks below.
//
// Business Unit is picked from a dropdown populated by /api/business-units
// (a GET to ServiceTitan's Business Units endpoint) -- the user never sees
// or types a raw ID. Fetched on mount, before the isNotAnInvoice early
// return below, since hooks must run unconditionally on every render.
export function ReviewTable({ invoice, onConfirm, onCancel }: ReviewTableProps) {
  const [draft, setDraft] = useState<ExtractedInvoice>(invoice);
  const [businessUnitId, setBusinessUnitId] = useState("");
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[] | null>(null);
  const [businessUnitsError, setBusinessUnitsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/business-units")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`);
        return res.json() as Promise<BusinessUnit[]>;
      })
      .then((units) => {
        if (cancelled) return;
        setBusinessUnits(units);
        // Only one option -- pre-select it so the user doesn't have to act,
        // but it still renders in the dropdown rather than being hidden.
        if (units.length === 1) {
          setBusinessUnitId(String(units[0].id));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setBusinessUnitsError(err instanceof Error ? err.message : "Failed to load business units");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isNotAnInvoice(draft)) {
    return (
      <div>
        <p role="alert">
          This document doesn&apos;t appear to be a vendor invoice
          {draft.notes ? ` -- ${draft.notes}` : ""}. There&apos;s nothing to review or submit.
        </p>
        <button type="button" onClick={onCancel}>
          Choose a different file
        </button>
      </div>
    );
  }

  const warnings = reviewWarnings(draft);
  const businessUnitFilled = businessUnitId.trim() !== "" && !Number.isNaN(Number(businessUnitId));
  const canSubmit = hasRequiredFields(draft) && businessUnitFilled;

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
  }

  function removeLineItem(index: number) {
    setDraft((prev) => ({ ...prev, lineItems: prev.lineItems.filter((_, i) => i !== index) }));
  }

  // TODO: recompute subtotal/total automatically as line items are edited --
  // currently these are direct editable fields, matching what the user typed
  // rather than a derived value.

  return (
    <div>
      <label>
        Vendor name
        <input
          type="text"
          placeholder="Enter vendor name"
          value={draft.vendorName}
          onChange={(e) => updateField("vendorName", e.target.value)}
        />
      </label>

      <label>
        Invoice #
        <input
          type="text"
          placeholder="Invoice number"
          value={draft.invoiceNumber}
          onChange={(e) => updateField("invoiceNumber", e.target.value)}
        />
      </label>

      <label>
        Invoice date
        <input
          type="text"
          placeholder="YYYY-MM-DD"
          value={draft.invoiceDate}
          onChange={(e) => updateField("invoiceDate", e.target.value)}
        />
      </label>

      <label>
        Project / job number (optional -- leave blank for bulk/inventory purchases)
        <input
          type="text"
          placeholder="Only if this purchase is tied to a specific job"
          value={draft.projectNumber ?? ""}
          onChange={(e) => updateField("projectNumber", e.target.value.trim() === "" ? null : e.target.value)}
        />
      </label>

      {warnings.length > 0 && (
        <div role="alert">
          <p>Flagged for review -- please check before submitting:</p>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {draft.notes && <p>{draft.notes}</p>}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Quantity</th>
            <th>Unit Price</th>
            <th>Total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {draft.lineItems.map((item, i) => (
            <tr key={i}>
              <td>
                <input
                  type="text"
                  placeholder="Item description"
                  value={item.description}
                  onChange={(e) => updateLineItem(i, "description", e.target.value)}
                />
              </td>
              <td>
                <input
                  type="number"
                  value={item.quantity}
                  onChange={(e) => updateLineItem(i, "quantity", Number(e.target.value))}
                />
              </td>
              <td>
                <input
                  type="number"
                  value={item.unitPrice}
                  onChange={(e) => updateLineItem(i, "unitPrice", Number(e.target.value))}
                />
              </td>
              <td>
                <input
                  type="number"
                  value={item.total}
                  onChange={(e) => updateLineItem(i, "total", Number(e.target.value))}
                />
              </td>
              <td>
                <button type="button" onClick={() => removeLineItem(i)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button type="button" onClick={addLineItem}>
        Add line item
      </button>

      <p>
        <label>
          Subtotal
          <input
            type="number"
            value={draft.subtotal}
            onChange={(e) => updateField("subtotal", Number(e.target.value))}
          />
        </label>
        <label>
          Tax
          <input
            type="number"
            placeholder="n/a"
            value={draft.taxAmount ?? ""}
            onChange={(e) => updateField("taxAmount", e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>
        <label>
          Total
          <input
            type="number"
            value={draft.total}
            onChange={(e) => updateField("total", Number(e.target.value))}
          />
        </label>
      </p>

      <label>
        Business Unit
        {businessUnitsError ? (
          <p role="alert">Couldn&apos;t load business units: {businessUnitsError}</p>
        ) : businessUnits === null ? (
          <p>Loading business units...</p>
        ) : businessUnits.length === 0 ? (
          <p role="alert">No business units found for this tenant.</p>
        ) : (
          <select value={businessUnitId} onChange={(e) => setBusinessUnitId(e.target.value)}>
            {businessUnits.length > 1 && (
              <option value="" disabled>
                Select a business unit
              </option>
            )}
            {businessUnits.map((bu) => (
              <option key={bu.id} value={bu.id}>
                {bu.name}
              </option>
            ))}
          </select>
        )}
      </label>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => onConfirm(draft, Number(businessUnitId))}
      >
        Confirm and Create PO
      </button>
    </div>
  );
}
