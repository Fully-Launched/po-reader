"use client";

import { useState } from "react";
import type { ExtractedInvoice } from "@/lib/types";

interface ReviewTableProps {
  invoice: ExtractedInvoice;
  onConfirm: (invoice: ExtractedInvoice) => void;
}

// Editable table shown between extraction and submission. This is the
// human-in-the-loop checkpoint: nothing is sent to ServiceTitan until the
// user confirms or corrects the vendor name and line items extracted from
// the invoice PDF.
export function ReviewTable({ invoice, onConfirm }: ReviewTableProps) {
  const [draft, setDraft] = useState<ExtractedInvoice>(invoice);

  // TODO: editable input for vendor name (draft.vendorName)
  // TODO: editable rows for each line item (description, quantity, unitCost, total)
  // TODO: add/remove line item controls
  // TODO: recompute/validate totals as the user edits
  // TODO: "Confirm and Create PO" button wired to onConfirm(draft)

  return (
    <div>
      <h2>{draft.vendorName}</h2>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Quantity</th>
            <th>Unit Cost</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {draft.lineItems.map((item, i) => (
            <tr key={i}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{item.unitCost}</td>
              <td>{item.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => onConfirm(draft)}>
        Confirm and Create PO
      </button>
    </div>
  );
}
