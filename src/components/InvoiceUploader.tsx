"use client";

import { useRef, useState } from "react";
import type { ExtractedInvoice, InvoiceBoundary } from "@/lib/types";
import { ReviewTable, type ReviewTableProps, type SubmitError } from "./ReviewTable";

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
//     reused for the batch summary screen below instead, since that's a
//     genuinely similar list-of-records UI.)
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
//     real Arco delivery format) is not in the mockup at all. STRICTLY
//     LINEAR, not a jumpable queue: BatchInvoiceScreen below shows only the
//     current invoice, auto-advances to the next one right after a PO is
//     created (or an invoice is skipped -- see onSkip), and auto-navigates
//     to BatchSummaryScreen once the last one is done. There is deliberately
//     no way to revisit an already-submitted invoice. A single-invoice
//     upload is unaffected -- same ReviewTable/ConfirmationScreen as always.

type Tab = "dashboard" | "edit" | "confirm";

interface QueuedInvoice {
  boundary: InvoiceBoundary;
  status: "pending" | "loading" | "ready" | "submitted" | "error" | "skipped";
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
  // per-invoice extraction (see loadQueuedInvoice below).
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

  // Synchronous re-entrancy guard for PO submission. `submitting` (React
  // state) is NOT safe for this by itself: state updates aren't applied
  // until after the event handler that triggered them returns, so two
  // click events arriving close together can both read `submitting` as
  // still `false` and both fire a real PurchaseOrders_Create request --
  // this is exactly how a rapid double-click on "Create purchase order"
  // was creating duplicate POs in ServiceTitan. A ref is mutated
  // synchronously, so it closes that race regardless of render timing.
  const submittingRef = useRef(false);

  const isBatch = batchQueue !== null;
  const batchAllSubmitted =
    isBatch && batchQueue!.every((q) => q.status === "submitted" || q.status === "skipped");

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

      // Bundle: set up the queue, but only eagerly extract the FIRST
      // invoice -- the rest are lazily extracted one at a time as the user
      // advances through the strict linear review flow (see
      // loadQueuedInvoice / advanceToNextOrFinish). Avoids both wasted API
      // calls for invoices the user may never get to, and the real risk of
      // a large bundle's combined output exceeding a single request's
      // time/token budget.
      const queue: QueuedInvoice[] = boundaries.map((boundary) => ({ boundary, status: "pending" }));
      setBatchQueue(queue);
      setActiveQueueIndex(0);
      setExtracting(false);
      setTab("edit");
      await loadQueuedInvoice(0, selectedFile, queue[0].boundary);
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

  // Lazily extracts ONE queued invoice's full data and stores it on its
  // queue slot. Re-sends the original file plus this invoice's page range
  // -- see /api/extract-invoice-page-range. Takes `targetFile`/`boundary`
  // as explicit arguments rather than reading `file`/`batchQueue` state,
  // since some call sites (e.g. the very first invoice, right after
  // setBatchQueue/setFile) would otherwise read a stale pre-update value --
  // React state updates aren't visible in the same synchronous call that
  // set them.
  async function loadQueuedInvoice(index: number, targetFile: File, boundary: InvoiceBoundary) {
    setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "loading", error: undefined } : q)));

    const formData = new FormData();
    formData.append("file", targetFile);
    formData.append("startPage", String(boundary.startPage));
    formData.append("endPage", String(boundary.endPage));

    try {
      const res = await fetch("/api/extract-invoice-page-range", { method: "POST", body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `Extraction failed (${res.status}) -- try again in a moment, or contact support if this persists.`);
      }
      setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "ready", invoice: body as ExtractedInvoice } : q)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed -- try again in a moment, or contact support if this persists.";
      setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "error", error: message } : q)));
    }
  }

  function handleRetryQueuedInvoice(index: number) {
    if (!file) return;
    void loadQueuedInvoice(index, file, batchQueue![index].boundary);
  }

  async function handleConfirm(
    invoice: ExtractedInvoice,
    businessUnitId: number,
    inventoryLocationId: number,
    requiredOn: string,
  ) {
    // See submittingRef's comment above -- checked-and-set synchronously,
    // before anything else, so a second call arriving before this one's
    // state updates have rendered is a no-op rather than a second real
    // network request.
    if (submittingRef.current) return;
    submittingRef.current = true;
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
        // type and per-field styling. This branch (and the catch below) is
        // the ONLY place a failure is ever reported -- the queue's status
        // never advances to "submitted" except from the res.ok branch below,
        // which only runs once the actual PurchaseOrders_Create response has
        // come back, so the displayed status always matches what really
        // happened, never an assumed/optimistic state.
        setSubmitError({ message: body.error ?? `PO creation failed (${res.status}). Try again in a moment, or contact support if this persists.`, field: body.field });
        return;
      }

      if (isBatch && activeQueueIndex !== null) {
        // Batch mode: record this PO on its queue slot, then automatically
        // move on to the next invoice (or, if this was the last one, to the
        // Confirmation summary) -- see advanceToNextOrFinish. No manual
        // "review next" click and no way back to an already-submitted
        // invoice, per the linear single-invoice-at-a-time redesign.
        const submittedIndex = activeQueueIndex;
        setBatchQueue((prev) => prev!.map((q, i) => (i === submittedIndex ? { ...q, status: "submitted" as const, poResult: body } : q)));
        await advanceToNextOrFinish(submittedIndex);
        return;
      }

      setSubmittedInvoice(invoice);
      setPoResult(body);
      setTab("confirm");
    } catch {
      setSubmitError({ message: "PO creation failed -- try again in a moment, or contact support if this persists." });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Shared by a just-submitted invoice (handleConfirm) and a skipped one
  // (handleSkipQueuedInvoice, e.g. a queued item that turns out not to be a
  // real invoice at all -- see ReviewTable's isNotAnInvoice hard block).
  // Moves to the next not-yet-handled invoice and lazily extracts it, or,
  // once nothing is left, navigates straight to the batch summary -- no
  // manual click required either way.
  async function advanceToNextOrFinish(currentIndex: number) {
    const queue = batchQueue!;
    const nextIndex = currentIndex + 1;
    if (nextIndex < queue.length && file) {
      setActiveQueueIndex(nextIndex);
      await loadQueuedInvoice(nextIndex, file, queue[nextIndex].boundary);
    } else {
      setActiveQueueIndex(null);
      setTab("confirm");
    }
  }

  function handleSkipQueuedInvoice(index: number) {
    setBatchQueue((prev) => prev!.map((q, i) => (i === index ? { ...q, status: "skipped" } : q)));
    void advanceToNextOrFinish(index);
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

        {tab === "edit" && isBatch && activeQueueIndex !== null && (
          <BatchInvoiceScreen
            queue={batchQueue!}
            activeIndex={activeQueueIndex}
            onRetry={handleRetryQueuedInvoice}
            onSkip={handleSkipQueuedInvoice}
            onConfirm={handleConfirm}
            submitting={submitting}
            submitError={submitError}
          />
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

// Multi-invoice bundle review -- NOT in the design mockup (which has no
// concept of a bundled upload). Strictly linear, deliberately NOT a
// jumpable list: shows only the CURRENT invoice (loading, error, or the
// review form), never the other invoices in the bundle, and there is no
// control anywhere in this component to go back to a previous one --
// avoids the "which one did I already submit" ambiguity a free-form queue
// invites. Advancing to the next invoice, and reaching the batch summary
// once the last one is done, both happen automatically from
// InvoiceUploader's advanceToNextOrFinish -- this component has no "next"
// button of its own.
function BatchInvoiceScreen({
  queue,
  activeIndex,
  onRetry,
  onSkip,
  onConfirm,
  submitting,
  submitError,
}: {
  queue: QueuedInvoice[];
  activeIndex: number;
  onRetry: (index: number) => void;
  onSkip: (index: number) => void;
  onConfirm: ReviewTableProps["onConfirm"];
  submitting: boolean;
  submitError: SubmitError | null;
}) {
  const item = queue[activeIndex];
  const label = item.invoice?.invoiceNumber ?? item.boundary.invoiceNumberPreview;

  return (
    <div className="screen">
      <div className="banner" style={{ background: "var(--border)", marginBottom: 12 }}>
        {queue.length} invoices detected in this bundle &middot; reviewing invoice {activeIndex + 1} of{" "}
        {queue.length}
        {label ? `: #${label}` : ""}
      </div>

      {item.status === "loading" && (
        <div className="status-loading">
          <i className="ti ti-loader-2" />
          <div className="title">Reading invoice {activeIndex + 1} of {queue.length}...</div>
        </div>
      )}

      {item.status === "error" && (
        <div className="banner banner-error">
          <i className="ti ti-alert-circle" />
          <div>
            {item.error}
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn-secondary" onClick={() => onRetry(activeIndex)}>
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {item.status === "ready" && item.invoice && (
        <ReviewTable
          invoice={item.invoice}
          onConfirm={onConfirm}
          onCancel={() => onSkip(activeIndex)}
          cancelLabel="Skip this invoice"
          submitting={submitting}
          submitError={submitError}
        />
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
  const createdCount = queue.filter((q) => q.status === "submitted").length;
  const skippedCount = queue.length - createdCount;

  return (
    <div className="screen">
      <div className="confirm-wrap">
        <div className="confirm-icon">
          <i className="ti ti-check" />
        </div>
        <div className="confirm-title">{createdCount} purchase order{createdCount === 1 ? "" : "s"} created</div>
        <div className="confirm-sub">
          Every invoice in this bundle has been submitted to ServiceTitan
          {skippedCount > 0 ? ` (${skippedCount} skipped -- not a valid invoice)` : ""}.
        </div>

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
                  {item.status === "skipped" ? (
                    <span className="pill warning">Skipped</span>
                  ) : (
                    <>
                      <span className="pill success">PO #{String(poNumber)}</span>
                      {typeof poViewUrl === "string" && (
                        <a href={poViewUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                          View
                        </a>
                      )}
                    </>
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
