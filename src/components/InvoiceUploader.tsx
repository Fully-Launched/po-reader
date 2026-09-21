"use client";

import { useRef, useState } from "react";
import type { ExtractedInvoice, InvoiceBoundary } from "@/lib/types";
import { ReviewTable, type SubmitError } from "./ReviewTable";

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
//     data source. (The mockup's `.log-list`/`.log-row`/`.pill` styles are
//     reused for the multi-invoice queue screen below instead, since that's
//     a genuinely similar list-of-records UI.)
//   - A failed PO submission keeps the user on the Review screen with an
//     inline error (see ReviewTable's submitError prop) instead of
//     discarding their edited draft -- the mockup has no error state to
//     model this against.
//   - "View in ServiceTitan" on the confirmation screen links to the created
//     PO using a CONFIRMED real deep-link pattern (client, live-tested) --
//     see ServiceTitanClient.buildPurchaseOrderViewUrl(). Falls back to a
//     disabled button with an honest tooltip only if the create-po response
//     had no usable internal id to build the link from.
//   - Multi-invoice bundle support (see CLAUDE.md's "Multi-invoice batch
//     flow" section): a PDF containing several invoices back-to-back (a
//     real Arco delivery format) is not in the mockup at all -- new queue
//     UI below, layered on top of the same single-invoice ReviewTable/
//     ConfirmationScreen so a single-invoice upload behaves identically to
//     before.

type Tab = "dashboard" | "edit" | "confirm";

interface QueuedInvoice {
  boundary: InvoiceBoundary;
  status: "pending" | "loading" | "ready" | "submitted" | "error";
  invoice?: ExtractedInvoice;
  poResult?: Record<string, unknown>;
  error?: string;
}

export function InvoiceUploader() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractedInvoice, setExtractedInvoice] = useState<ExtractedInvoice | null>(null);

  // The originally uploaded file -- kept (not just consumed once) so a
  // multi-invoice bundle can re-send it for each queued invoice's lazy
  // per-invoice extraction (see handleReviewQueuedInvoice below).
  const [file, setFile] = useState<File | null>(null);

  // Multi-invoice bundle state -- null means "not a bundle", and every
  // single-invoice code path below behaves exactly as it did before this
  // was added. Lives in this top-level component (not inside a tab-specific
  // child), so switching tabs (e.g. to Dashboard and back) never loses it --
  // satisfies "don't lose progress if the user navigates away mid-queue".
  // Does NOT survive an actual page reload (no persistence layer exists in
  // this app at all -- see CLAUDE.md) -- flagged as a known limitation.
  const [batchQueue, setBatchQueue] = useState<QueuedInvoice[] | null>(null);
  const [activeQueueIndex, setActiveQueueIndex] = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  const [submittedInvoice, setSubmittedInvoice] = useState<ExtractedInvoice | null>(null);
  const [poResult, setPoResult] = useState<Record<string, unknown> | null>(null);

  // Guards against a slow extraction call clobbering state after the user
  // has already started over (clicked Dashboard, picked a different file).
  const requestId = useRef(0);

  const isBatch = batchQueue !== null;
  const batchAllSubmitted = isBatch && batchQueue!.every((q) => q.status === "submitted");

  function canGoTo(target: Tab): boolean {
    if (target === "dashboard") return true;
    if (target === "edit") return (extractedInvoice !== null || isBatch) && tab !== "confirm";
    if (target === "confirm") return poResult !== null || batchAllSubmitted;
    return false;
  }

  function startOver() {
    requestId.current += 1;
    setExtracting(false);
    setExtractError(null);
    setExtractedInvoice(null);
    setFile(null);
    setBatchQueue(null);
    setActiveQueueIndex(null);
    setSubmitting(false);
    setSubmitError(null);
    setSubmittedInvoice(null);
    setPoResult(null);
    setTab("dashboard");
  }

  // First step for every upload: scan the WHOLE document to find invoice
  // boundaries before extracting anything in full -- see
  // detectInvoiceBoundaries() in extraction.ts. A single-boundary result
  // means "not a bundle": falls straight through to the existing
  // single-invoice extraction, unchanged from before this feature existed.
  async function handleFileSelected(selectedFile: File) {
    const thisRequest = ++requestId.current;
    setExtracting(true);
    setExtractError(null);
    setFile(selectedFile);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch("/api/detect-invoice-boundaries", { method: "POST", body: formData });
      if (thisRequest !== requestId.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Extraction failed (${res.status}) -- try again in a moment, or contact support if this persists.`);
      }
      const { boundaries }: { boundaries: InvoiceBoundary[] } = await res.json();
      if (thisRequest !== requestId.current) return;

      if (boundaries.length <= 1) {
        // Not a bundle -- identical to the original single-invoice flow.
        await extractSingleInvoice(selectedFile, thisRequest);
        return;
      }

      // Bundle: set up the queue, but DON'T eagerly extract every invoice --
      // each one is only fully extracted when the user actually reviews it
      // (see handleReviewQueuedInvoice). Avoids both wasted API calls for
      // invoices the user may never get to, and the real risk of a large
      // bundle's combined output exceeding a single request's time/token
      // budget.
      setBatchQueue(boundaries.map((boundary) => ({ boundary, status: "pending" })));
      setActiveQueueIndex(null);
      setExtracting(false);
      setTab("edit");
    } catch (err) {
      if (thisRequest !== requestId.current) return;
      setExtractError(err instanceof Error ? err.message : "Extraction failed -- try again in a moment, or contact support if this persists.");
      setExtracting(false);
    }
  }

  async function extractSingleInvoice(selectedFile: File, thisRequest: number) {
    const formData = new FormData();
    formData.append("file", selectedFile);
    try {
      const res = await fetch("/api/extract-invoice", { method: "POST", body: formData });
      if (thisRequest !== requestId.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Extraction failed (${res.status}) -- try again in a moment, or contact support if this persists.`);
      }
      const extracted: ExtractedInvoice = await res.json();
      if (thisRequest !== requestId.current) return;
      setExtractedInvoice(extracted);
      setExtracting(false);
      setTab("edit");
    } catch (err) {
      if (thisRequest !== requestId.current) return;
      setExtractError(err instanceof Error ? err.message : "Extraction failed -- try again in a moment, or contact support if this persists.");
      setExtracting(false);
    }
  }

  // Lazily extracts ONE queued invoice's full data (if not already
  // extracted) and drills into it for review. Re-sends the original file
  // plus this invoice's page range -- see /api/extract-invoice-page-range.
  async function handleReviewQueuedInvoice(index: number) {
    const item = batchQueue![index];
    if (item.status === "ready" || item.status === "submitted") {
      setActiveQueueIndex(index);
      return;
    }
    if (!file) return;

    setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "loading", error: undefined } : q)));

    const formData = new FormData();
    formData.append("file", file);
    formData.append("startPage", String(item.boundary.startPage));
    formData.append("endPage", String(item.boundary.endPage));

    try {
      const res = await fetch("/api/extract-invoice-page-range", { method: "POST", body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `Extraction failed (${res.status}) -- try again in a moment, or contact support if this persists.`);
      }
      setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "ready", invoice: body as ExtractedInvoice } : q)));
      setActiveQueueIndex(index);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed -- try again in a moment, or contact support if this persists.";
      setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "error", error: message } : q)));
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
        // Stay on the review screen with the user's edits intact -- don't
        // discard the draft on a failed submission. `body.field`, when
        // present, names the specific input that caused the failure (e.g.
        // "projectNumber" for a job-not-found error) so the review table can
        // highlight that exact field -- see ReviewTable.tsx's SubmitError
        // type and per-field styling.
        setSubmitError({ message: body.error ?? `PO creation failed (${res.status}). Try again in a moment, or contact support if this persists.`, field: body.field });
        setSubmitting(false);
        return;
      }

      if (isBatch && activeQueueIndex !== null) {
        // Batch mode: record this PO on its queue slot and return to the
        // queue overview (not the single-PO Confirmation screen) so the
        // user can see progress and choose whether to continue -- never
        // forced through the rest of the queue in one sitting.
        const submittedIndex = activeQueueIndex;
        setBatchQueue((prev) => {
          const next = prev!.map((q, i) => (i === submittedIndex ? { ...q, status: "submitted" as const, poResult: body } : q));
          return next;
        });
        setActiveQueueIndex(null);
        setSubmitting(false);
        return;
      }

      setSubmittedInvoice(invoice);
      setPoResult(body);
      setSubmitting(false);
      setTab("confirm");
    } catch {
      setSubmitError({ message: "PO creation failed -- try again in a moment, or contact support if this persists." });
      setSubmitting(false);
    }
  }

  const activeQueueInvoice =
    isBatch && activeQueueIndex !== null ? batchQueue![activeQueueIndex] : null;

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

        {tab === "edit" && isBatch && activeQueueInvoice === null && (
          <BatchQueueScreen queue={batchQueue!} onReview={handleReviewQueuedInvoice} />
        )}

        {tab === "edit" && isBatch && activeQueueInvoice?.invoice && (
          <>
            <div className="banner" style={{ background: "var(--border)", marginBottom: 12 }}>
              Invoice {activeQueueIndex! + 1} of {batchQueue!.length}
              {activeQueueInvoice.invoice.invoiceNumber ? `: #${activeQueueInvoice.invoice.invoiceNumber}` : ""}
              {" -- "}
              <button type="button" className="btn-ghost" onClick={() => setActiveQueueIndex(null)}>
                Back to queue
              </button>
            </div>
            <ReviewTable
              invoice={activeQueueInvoice.invoice}
              onConfirm={handleConfirm}
              onCancel={() => setActiveQueueIndex(null)}
              submitting={submitting}
              submitError={submitError}
            />
          </>
        )}

        {tab === "edit" && !isBatch && extractedInvoice && (
          <ReviewTable
            invoice={extractedInvoice}
            onConfirm={handleConfirm}
            onCancel={startOver}
            submitting={submitting}
            submitError={submitError}
          />
        )}

        {tab === "confirm" && isBatch && batchAllSubmitted && (
          <BatchSummaryScreen queue={batchQueue!} onStartOver={startOver} />
        )}

        {tab === "confirm" && !isBatch && poResult && (
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
            <div className="title">Reading invoice data...</div>
            <div className="sub">This can take a moment for larger invoices or bundles</div>
          </>
        ) : (
          <>
            <i className="ti ti-upload" />
            <div className="title">Drop an invoice here</div>
            <div className="sub">or browse for a PDF -- a single invoice, or a bundle of several</div>
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

const QUEUE_STATUS_PILL: Record<QueuedInvoice["status"], { label: string; variant: "success" | "warning" | "error" }> = {
  pending: { label: "Not reviewed", variant: "warning" },
  loading: { label: "Loading...", variant: "warning" },
  ready: { label: "Ready to review", variant: "warning" },
  submitted: { label: "PO created", variant: "success" },
  error: { label: "Failed to load", variant: "error" },
};

// Multi-invoice bundle queue -- NOT in the design mockup (which has no
// concept of a bundled upload). Reuses the mockup's `.log-list`/`.log-row`/
// `.pill` styles (the same ones behind the Dashboard's omitted activity
// log), since this is genuinely the same "list of records with a status"
// shape. Deliberately does NOT auto-advance through the queue or force the
// user through every invoice in one sitting -- each row is reviewed on
// demand, and the user can leave whenever they want with the rest still
// sitting here as "Not reviewed".
function BatchQueueScreen({
  queue,
  onReview,
}: {
  queue: QueuedInvoice[];
  onReview: (index: number) => void;
}) {
  const submittedCount = queue.filter((q) => q.status === "submitted").length;
  const nextPendingIndex = queue.findIndex((q) => q.status === "pending" || q.status === "error");

  return (
    <div className="screen">
      <div className="card">
        <div className="section-label">
          Invoice bundle &middot; {submittedCount} of {queue.length} submitted
        </div>
        <div className="log-list">
          {queue.map((item, i) => {
            const pill = QUEUE_STATUS_PILL[item.status];
            const label =
              item.invoice?.invoiceNumber ??
              item.boundary.invoiceNumberPreview ??
              `pages ${item.boundary.startPage}-${item.boundary.endPage}`;
            return (
              <div className="log-row" key={i}>
                <div className="left">
                  <i className="ti ti-file-invoice" />
                  <span>
                    Invoice {i + 1} of {queue.length}
                    {label ? ` -- #${label}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`pill ${pill.variant}`}>{pill.label}</span>
                  {item.status !== "submitted" && (
                    <button type="button" className="btn-ghost" onClick={() => onReview(i)}>
                      {item.status === "error" ? "Retry" : "Review"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {queue.some((q) => q.status === "error") && (
          <div className="banner banner-error" style={{ marginTop: 12 }}>
            <i className="ti ti-alert-circle" />
            {queue.find((q) => q.status === "error")?.error}
          </div>
        )}
      </div>

      {nextPendingIndex !== -1 && (
        <button type="button" className="btn-primary" onClick={() => onReview(nextPendingIndex)}>
          Review next invoice ({nextPendingIndex + 1} of {queue.length})
        </button>
      )}
    </div>
  );
}

function BatchSummaryScreen({
  queue,
  onStartOver,
}: {
  queue: QueuedInvoice[];
  onStartOver: () => void;
}) {
  return (
    <div className="screen">
      <div className="confirm-wrap">
        <div className="confirm-icon">
          <i className="ti ti-check" />
        </div>
        <div className="confirm-title">{queue.length} purchase orders created</div>
        <div className="confirm-sub">Every invoice in this bundle has been submitted to ServiceTitan.</div>

        <div className="banner banner-warning" style={{ marginTop: 12 }}>
          <i className="ti ti-alert-triangle" />
          Remember to double-check each PO shows as <strong>Received</strong> in ServiceTitan.
          Auto-receive depends on a setting on the PO Type used, not on this app.
        </div>

        <div className="log-list" style={{ marginTop: 16, width: "100%" }}>
          {queue.map((item, i) => {
            // `number` (display PO number, e.g. "2117-005") preferred over
            // `id` (internal numeric id, e.g. 20522 -- used for poViewUrl
            // instead, NOT for display -- CONFIRMED distinct fields, client).
            const poNumber = item.poResult?.number ?? item.poResult?.poNumber ?? item.poResult?.id ?? "unknown";
            const poViewUrl = item.poResult?.poViewUrl;
            return (
              <div className="log-row" key={i}>
                <div className="left">
                  <i className="ti ti-file-invoice" />
                  <span>
                    {item.invoice?.vendorName ?? "Invoice"} &middot; #{item.invoice?.invoiceNumber ?? "—"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pill success">PO #{String(poNumber)}</span>
                  {typeof poViewUrl === "string" && (
                    <a href={poViewUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                      View
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="confirm-actions">
          <button type="button" className="btn-primary" onClick={onStartOver}>
            Upload another invoice
          </button>
        </div>
      </div>
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
  // `number` (display PO number, e.g. "2117-005") preferred over `id`
  // (internal numeric id, e.g. 20522 -- used for poViewUrl instead, NOT for
  // display -- CONFIRMED distinct fields, client, live-tested).
  const poNumber = poResult.number ?? poResult.poNumber ?? poResult.id ?? "unknown";
  const poViewUrl = poResult.poViewUrl;

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
          {/* CONFIRMED URL pattern (client, live-tested) -- see
              ServiceTitanClient.buildPurchaseOrderViewUrl()'s doc comment.
              poViewUrl is computed server-side in /api/create-po and comes
              back null if the response had no usable internal id, in which
              case this falls back to a disabled button with an honest
              tooltip rather than a broken link. */}
          {typeof poViewUrl === "string" ? (
            <a href={poViewUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary">
              View in ServiceTitan
            </a>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              disabled
              title="Find this PO in ServiceTitan under Purchase Orders"
            >
              View in ServiceTitan
            </button>
          )}
          <button type="button" className="btn-primary" onClick={onStartOver}>
            Upload another invoice
          </button>
        </div>
      </div>
    </div>
  );
}
