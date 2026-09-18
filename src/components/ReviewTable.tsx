"use client";

import { useState } from "react";
import type { ExtractedInvoice } from "@/lib/types";
import { needsHumanReview } from "@/lib/servicetitan/payload-builder";

interface ReviewTableProps {
  invoice: ExtractedInvoice;
  onConfirm: (invoice: ExtractedInvoice, businessUnitId: number) => void;
}

// Editable table shown between extraction and submission. This is the
// human-in-the-loop checkpoint: nothing is sent to ServiceTitan until the
// user confirms or corrects the vendor name, project number, and line items
// extracted from the invoice PDF.
//
// businessUnitId is collected here (rather than looked up) because no
// business-unit resolution logic exists yet -- see CLAUDE.md open questions.
export function ReviewTable({ invoice, onConfirm }: ReviewTableProps) {
  const [draft, setDraft] = useState<ExtractedInvoice>(invoice);
  const [businessUnitId, setBusinessUnitId] = useState("");

  const flagged = needsHumanReview(draft);
  const canSubmit = businessUnitId.trim() !== "" && !Number.isNaN(Number(businessUnitId));

  // TODO: editable inputs for vendorName, projectNumber, invoiceDate, taxAmount
  // TODO: editable rows for each line item (description, quantity, unitPrice, total)
  // TODO: add/remove line item controls
  // TODO: recompute subtotal/total as the user edits line items

  return (
    <div>
      <h2>{draft.vendorName}</h2>
      <p>Invoice #{draft.invoiceNumber} &middot; {draft.invoiceDate}</p>
      <p>Project number: {draft.projectNumber ?? "(none found -- required before submission)"}</p>

      {flagged && (
        <p role="alert">
          Flagged for review: {draft.extractionConfidence !== "high"
            ? `extraction confidence is "${draft.extractionConfidence}"`
            : !draft.projectNumber
              ? "no project number found"
              : "no line items extracted"}
          {draft.notes ? ` -- ${draft.notes}` : ""}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Quantity</th>
            <th>Unit Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {draft.lineItems.map((item, i) => (
            <tr key={i}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{item.unitPrice}</td>
              <td>{item.total}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>Subtotal: {draft.subtotal} &middot; Tax: {draft.taxAmount ?? "n/a"} &middot; Total: {draft.total}</p>

      <label>
        ServiceTitan Business Unit ID
        <input
          type="number"
          value={businessUnitId}
          onChange={(e) => setBusinessUnitId(e.target.value)}
        />
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
