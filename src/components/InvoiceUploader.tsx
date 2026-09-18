"use client";

import { useState } from "react";
import type { ExtractedInvoice } from "@/lib/types";
import { ReviewTable } from "./ReviewTable";

// Top-level client component driving the upload -> extract -> review ->
// submit flow described in CLAUDE.md. State machine:
//   "upload"  -> user drags/selects a PDF
//   "review"  -> extraction result shown in an editable table for confirmation
//   "success" -> PO created + received in ServiceTitan

type Stage = "upload" | "review" | "success";

export function InvoiceUploader() {
  const [stage, setStage] = useState<Stage>("upload");
  const [extractedInvoice, setExtractedInvoice] =
    useState<ExtractedInvoice | null>(null);

  async function handleFileSelected(file: File) {
    // TODO: POST the file to /api/extract-invoice as multipart/form-data
    // TODO: on success, setExtractedInvoice(result) and setStage("review")
    // TODO: on failure, surface an error state to the user
    void file;
  }

  async function handleConfirm(invoice: ExtractedInvoice) {
    // TODO: POST the (human-corrected) invoice to /api/create-po
    // TODO: on success, setStage("success")
    // TODO: on failure, surface an error state so the user can retry/correct
    void invoice;
  }

  if (stage === "review" && extractedInvoice) {
    return (
      <ReviewTable invoice={extractedInvoice} onConfirm={handleConfirm} />
    );
  }

  if (stage === "success") {
    // TODO: show the created PO / receipt confirmation details
    return <p>Purchase order created and received in ServiceTitan.</p>;
  }

  return (
    <div>
      {/* TODO: drag-and-drop zone + file picker fallback for the vendor invoice PDF */}
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
