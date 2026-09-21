"use client";

import { useRef, useState } from "react";
import type { ExtractedInvoice } from "@/lib/types";
import { ReviewTable } from "./ReviewTable";

// Top-level app shell, layout ported from po-generator-draft.html (design
// mockup): nav-rail + tabs + branded header + one of three screens +
// footer. Drives the upload -> extract -> review -> submit flow described
// in CLAUDE.md.
//
// Deliberate departures from the mockup (a static demo, freely clickable
// between screens):
//   - Tabs/nav-rail are gated by real progress -- you can't jump to "Review
//     invoice" before an invoice is loaded, or "Confirmation" before a PO
//     actually exists. See canGoTo() below.
//   - The mockup's Dashboard screen has a "This week" activity log with
//     example rows (Arco Supply INV-23538, etc.). This app has no
//     persistence layer to back a real activity log, so it's omitted rather
//     than showing fabricated history -- add it back once there's a real
//     data source.
//   - A failed PO submission keeps the user on the Review screen with an
//     inline error (see ReviewTable's submitError prop) instead of
//     discarding their edited draft -- the mockup has no error state to
//     model this against.
//   - "View in ServiceTitan" on the confirmation screen is disabled: there's
//     no confirmed URL pattern for deep-linking into a ServiceTitan tenant's
//     PO view (see CLAUDE.md open questions).

type Tab = "dashboard" | "edit" | "confirm";

export function InvoiceUploader() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractedInvoice, setExtractedInvoice] = useState<ExtractedInvoice | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [submittedInvoice, setSubmittedInvoice] = useState<ExtractedInvoice | null>(null);
  const [poResult, setPoResult] = useState<Record<string, unknown> | null>(null);

  // Guards against a slow extraction call clobbering state after the user
  // has already started over (clicked Dashboard, picked a different file).
  const requestId = useRef(0);

  function canGoTo(target: Tab): boolean {
    if (target === "dashboard") return true;
    if (target === "edit") return extractedInvoice !== null && tab !== "confirm";
    if (target === "confirm") return poResult !== null;
    return false;
  }

  function startOver() {
    requestId.current += 1;
    setExtracting(false);
    setExtractError(null);
    setExtractedInvoice(null);
    setSubmitting(false);
    setSubmitError(null);
    setSubmittedInvoice(null);
    setPoResult(null);
    setTab("dashboard");
  }

  async function handleFileSelected(file: File) {
    const thisRequest = ++requestId.current;
    setExtracting(true);
    setExtractError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/extract-invoice", { method: "POST", body: formData });
      if (thisRequest !== requestId.current) return; // superseded by a newer request
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Extraction failed (${res.status})`);
      }
      const extracted: ExtractedInvoice = await res.json();
      if (thisRequest !== requestId.current) return;
      setExtractedInvoice(extracted);
      setExtracting(false);
      setTab("edit");
    } catch (err) {
      if (thisRequest !== requestId.current) return;
      setExtractError(err instanceof Error ? err.message : "Extraction failed");
      setExtracting(false);
    }
  }

  async function handleConfirm(
    invoice: ExtractedInvoice,
    businessUnitId: number,
    inventoryLocationId: number,
    requiredOn: string,
  ) {
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/create-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice, businessUnitId, inventoryLocationId, requiredOn }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `PO creation failed (${res.status})`);
      }
      setSubmittedInvoice(invoice);
      setPoResult(body);
      setSubmitting(false);
      setTab("confirm");
    } catch (err) {
      // Stay on the review screen with the user's edits intact -- don't
      // discard the draft on a failed submission.
      setSubmitError(err instanceof Error ? err.message : "PO creation failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="nav-rail">
        <i
          className={`ti ti-home ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => canGoTo("dashboard") && setTab("dashboard")}
        />
        <i
          className={`ti ti-file-invoice ${tab === "edit" ? "active" : ""} ${!canGoTo("edit") ? "disabled" : ""}`}
          onClick={() => canGoTo("edit") && setTab("edit")}
        />
        {/* No activity-history view exists yet -- goes to Dashboard like the mockup's second nav icon did. */}
        <i className="ti ti-history" onClick={() => canGoTo("dashboard") && setTab("dashboard")} />
      </div>

      <div className="content">
        <div className="tabs">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
            Dashboard
          </button>
          <button className={tab === "edit" ? "active" : ""} disabled={!canGoTo("edit")} onClick={() => setTab("edit")}>
            Review invoice
          </button>
          <button className={tab === "confirm" ? "active" : ""} disabled={!canGoTo("confirm")} onClick={() => setTab("confirm")}>
            Confirmation
          </button>
        </div>

        <header className="app-header">
          <div>
            <div className="brand-title">Comfort x Design</div>
            <div className="brand-subtitle">Purchase Order Generator</div>
          </div>
        </header>

        {tab === "dashboard" && (
          <DashboardScreen
            extracting={extracting}
            extractError={extractError}
            onFileSelected={handleFileSelected}
          />
        )}

        {tab === "edit" && extractedInvoice && (
          <ReviewTable
            invoice={extractedInvoice}
            onConfirm={handleConfirm}
            onCancel={startOver}
            submitting={submitting}
            submitError={submitError}
          />
        )}

        {tab === "confirm" && poResult && (
          <ConfirmationScreen invoice={submittedInvoice} poResult={poResult} onStartOver={startOver} />
        )}

        <footer className="app-footer">For help, reach out to matteo@fullylaunched.com</footer>
      </div>
    </div>
  );
}

function DashboardScreen({
  extracting,
  extractError,
  onFileSelected,
}: {
  extracting: boolean;
  extractError: string | null;
  onFileSelected: (file: File) => void;
}) {
  return (
    <div className="screen">
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) onFileSelected(file);
        }}
      >
        {extracting ? (
          <>
            <i className="ti ti-loader-2" />
            <div className="title">Extracting invoice data...</div>
            <div className="sub">This can take a moment for larger invoices</div>
          </>
        ) : (
          <>
            <i className="ti ti-upload" />
            <div className="title">Drop an invoice here</div>
            <div className="sub">or browse for a PDF</div>
            <input
              type="file"
              accept="application/pdf"
              disabled={extracting}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFileSelected(file);
              }}
            />
          </>
        )}
      </div>

      {extractError && (
        <div className="banner banner-error">
          <i className="ti ti-alert-circle" />
          {extractError}
        </div>
      )}
    </div>
  );
}

function ConfirmationScreen({
  invoice,
  poResult,
  onStartOver,
}: {
  invoice: ExtractedInvoice | null;
  poResult: Record<string, unknown>;
  onStartOver: () => void;
}) {
  // ServiceTitan's PurchaseOrders_Create response shape isn't confirmed
  // live (see CLAUDE.md) -- try the field names that seem most plausible
  // rather than assuming one.
  const poNumber = poResult.number ?? poResult.poNumber ?? poResult.id ?? "unknown";

  return (
    <div className="screen">
      <div className="confirm-wrap">
        <div className="confirm-icon">
          <i className="ti ti-check" />
        </div>
        <div className="confirm-title">Purchase order created</div>
        <div className="confirm-sub">
          PO #{String(poNumber)} &middot; created and auto-received in ServiceTitan
          {/* NOT claiming "and billed automatically" -- whether a bill auto-generates on receipt
              depends on the client's Inventory Configuration setting, which is still an open
              question in CLAUDE.md, not something this tool has confirmed either way. */}
        </div>

        {/* Safety-net reminder, not a status warning: auto-receive is a ServiceTitan-side
            "Automatically Receive" setting on the PO Type used, configured in Kevin's own
            ServiceTitan account -- this app never sets receive status itself, it only selects
            which existing PO Type to reference. Keep this reminder even once that setting is
            reliably working, as a safety net in case the account-side config ever changes. */}
        <div className="banner banner-warning" style={{ marginTop: 12 }}>
          <i className="ti ti-alert-triangle" />
          Remember to double-check this PO shows as <strong>Received</strong> in ServiceTitan.
          Auto-receive depends on a setting on the PO Type used, not on this app.
        </div>

        {invoice && (
          <div className="confirm-card">
            <div className="confirm-row">
              <span>Vendor</span>
              <span>{invoice.vendorName}</span>
            </div>
            {invoice.projectNumber && (
              <div className="confirm-row">
                <span>Project</span>
                <span>{invoice.projectNumber}</span>
              </div>
            )}
            <div className="confirm-row">
              <span>Total</span>
              <span style={{ fontWeight: 500 }}>${invoice.total.toFixed(2)}</span>
            </div>
          </div>
        )}

        <div className="confirm-actions">
          {/* Disabled: no confirmed URL pattern for deep-linking into a
              ServiceTitan tenant's PO view -- see CLAUDE.md open questions. */}
          <button type="button" className="btn-secondary" disabled title="Not available yet">
            View in ServiceTitan
          </button>
          <button type="button" className="btn-primary" onClick={onStartOver}>
            Upload another invoice
          </button>
        </div>
      </div>
    </div>
  );
}
