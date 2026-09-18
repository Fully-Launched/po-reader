"use client";

import { useState } from "react";
import type { ExtractedInvoice } from "@/lib/types";
import { ReviewTable } from "./ReviewTable";

// Top-level client component driving the upload -> extract -> review ->
// submit flow described in CLAUDE.md. State machine:
//   "upload"    -> user drags/selects a PDF
//   "extracting"-> waiting on /api/extract-invoice
//   "review"    -> extraction result shown in an editable table for confirmation
//   "submitting"-> waiting on /api/create-po
//   "success"   -> PO created (and auto-received, if the PO Type supports it)
//   "error"     -> something failed; message shown, user can retry

type Stage = "upload" | "extracting" | "review" | "submitting" | "success" | "error";

export function InvoiceUploader() {
  const [stage, setStage] = useState<Stage>("upload");
  const [extractedInvoice, setExtractedInvoice] = useState<ExtractedInvoice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [poResult, setPoResult] = useState<Record<string, unknown> | null>(null);

  async function handleFileSelected(file: File) {
    setStage("extracting");
    setErrorMessage(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/extract-invoice", { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Extraction failed (${res.status})`);
      }
      const extracted: ExtractedInvoice = await res.json();
      setExtractedInvoice(extracted);
      setStage("review");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Extraction failed");
      setStage("error");
    }
  }

  async function handleConfirm(invoice: ExtractedInvoice, businessUnitId: number) {
    setStage("submitting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/create-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice, businessUnitId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `PO creation failed (${res.status})`);
      }
      setPoResult(body);
      setStage("success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "PO creation failed");
      setStage("error");
    }
  }

  if (stage === "review" && extractedInvoice) {
    return <ReviewTable invoice={extractedInvoice} onConfirm={handleConfirm} />;
  }

  if (stage === "extracting") {
    return <p>Extracting invoice data...</p>;
  }

  if (stage === "submitting") {
    return <p>Creating purchase order in ServiceTitan...</p>;
  }

  if (stage === "success") {
    return (
      <div>
        <p>Purchase order created in ServiceTitan.</p>
        <pre>{JSON.stringify(poResult, null, 2)}</pre>
      </div>
    );
  }

  if (stage === "error") {
    return (
      <div>
        <p role="alert">{errorMessage}</p>
        <button type="button" onClick={() => setStage("upload")}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* TODO: real drag-and-drop zone; this is a file picker fallback only */}
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
        }}
      />
    </div>
  );
}
