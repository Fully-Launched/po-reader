# PO-Reader

## Project Purpose

PO-Reader is an internal tool built for **Comfort x Design**, a single ServiceTitan customer, to automate the invoice-to-Purchase-Order workflow for their **3 non-integrated vendors** (vendors with no direct ServiceTitan integration, so invoices are currently keyed in by hand). Arco Supply Co. is the first confirmed vendor (real sample invoice received and validated); the other 2 are expected to use a nearly identical invoice format (confirmed by the client contact, Kevin, Sept 2026).

**Flow:**
1. User drags a vendor invoice PDF into the app.
2. The Claude API extracts structured invoice data from the PDF: vendor name, invoice number, invoice date, project number, line items (description, quantity, unit price, total), tax amount, subtotal, total, plus an `extraction_confidence` rating and free-text `notes`.
3. A human reviews and corrects the extracted data in a fully editable table. Extraction is treated as a starting draft, not a pass/fail gate: `extraction_confidence` below `"high"`, a missing vendor name/project number, or no line items show a non-blocking warning banner (see `reviewWarnings` in `src/lib/servicetitan/payload-builder.ts`) but never disable the form — the user can add, remove, or correct any field, including ones the extraction missed entirely, before submitting. The only hard block is a document that isn't a vendor invoice at all (e.g. an internal memo) — see `isNotAnInvoice` — since there's no partial data worth editing in that case.
4. On confirmation, the tool resolves the ServiceTitan vendor and job, then creates a Purchase Order via `PurchaseOrders_Create`.
5. **There is no separate "receive" step.** See the important correction below.

This is not a general-purpose product. It is built exclusively for Comfort x Design's ServiceTitan tenant and is not intended for redistribution or multi-tenant use.

### Important correction: how receiving actually works

An earlier version of this document assumed the tool would call a ServiceTitan "Receipts" endpoint after PO creation to receive the PO. **This is wrong and has been confirmed wrong against ServiceTitan's own developer docs.** Per their Inventory API resource page: *"A purchase order status cannot be updated through API."* There is no receive/status-change endpoint — full stop.

The **only** way a PO ends up `Received` (and, if enabled, auto-generates a bill) via the API is to **create it using a PO Type that has "Automatically Receive" enabled** — status and bill generation happen automatically at creation time, not via any follow-up call. In the sandbox, the PO Type named `"Supply House Run"` has this enabled. `buildPoPayload()` (`src/lib/servicetitan/payload-builder.ts`) requires a `poTypeId` for exactly this reason, and `/api/create-po` looks it up via `ServiceTitanClient.getPoTypeIdByName()`.

`ServiceTitanClient.updatePurchaseOrder()` exists in the client but is explicitly **not** for status changes — see the warning comment on that method.

## Architecture

- **Framework:** Next.js, deployed to Vercel.
- **App Router** is used for routing.

### Core library code (`src/lib/`)

This logic was ported from an earlier Python prototype (`comfort-x-design-invoice-tool`) that was validated against a real Arco Supply invoice sample — it isn't from-scratch/unvalidated code, and the TODOs below reflect genuine open items from that prototype, not just caution.

- **`src/lib/types.ts`** — `ExtractedInvoice` / `InvoiceLineItem`, the shape that flows extraction → review table → PO creation.
- **`src/lib/extraction.ts`** — `extractInvoice(pdfBuffer)`: sends the PDF to Claude with a defined extraction prompt/JSON schema, parses and normalizes the response into `ExtractedInvoice`.
- **`src/lib/servicetitan/client.ts`** — `ServiceTitanClient`: OAuth2 `client_credentials` token fetch/cache, `createPurchaseOrder`, `getPoTypeIdByName`, `findVendorByName`. `findJobByProjectNumber` is **not implemented** — throws, pending JPM API research (see Open Questions).
- **`src/lib/servicetitan/payload-builder.ts`** — `buildPoPayload()` converts an `ExtractedInvoice` + resolved IDs into the `PurchaseOrders_Create` request body. Three review/guardrail functions, all pure (safe to call from client or server code): `reviewWarnings()` / `needsHumanReview()` are non-blocking — they surface a warning banner but never disable submission; `isNotAnInvoice()` is the one hard-block gate (document isn't a vendor invoice at all); `hasRequiredFields()` is the actual submission gate (vendor name, project number, and at least one valid line item present, regardless of confidence or how they got there).

### API Routes

- **`/api/extract-invoice`**
  Accepts a PDF upload (`multipart/form-data`, field `file`), calls `extractInvoice()`, returns the structured `ExtractedInvoice`.

- **`/api/create-po`**
  Takes the human-reviewed `ExtractedInvoice` (plus a `businessUnitId` — see below), resolves the ServiceTitan vendor (`findVendorByName`) and job (`findJobByProjectNumber` — currently unimplemented, so this route currently always 501s at that step), resolves the auto-receive PO Type ID, builds the payload, and calls `PurchaseOrders_Create`. Re-runs `isNotAnInvoice` and `hasRequiredFields` server-side as defense in depth even though the frontend should already gate on the same checks — does NOT re-check confidence, since low confidence is not a submission blocker (see Flow above).

  **`businessUnitId` is currently supplied by the user in the review table**, not looked up — no business-unit resolution logic has been built yet (see Open Questions).

### Frontend

- **Upload screen** (`src/components/InvoiceUploader.tsx`) — file picker for the vendor invoice PDF (drag-and-drop is a TODO), drives the upload → extract → review → submit state machine, kicks off `/api/extract-invoice`.
- **Review table** (`src/components/ReviewTable.tsx`) — shown between extraction and submission. This is the human-in-the-loop checkpoint: nothing is written to ServiceTitan until the user confirms/corrects the extracted data and supplies a Business Unit ID. Surfaces the `needsHumanReview` flag as a visible warning. Submission calls `/api/create-po`.

The review table is a deliberate design choice, not a placeholder to be removed later — Claude's extraction is not assumed to be perfect, and PO creation (which, per the correction above, auto-receives and can auto-bill) is not something we want to auto-fire on unverified data.

## ServiceTitan Integration Specifics

- **App type:** Customer-Built App (not a Marketplace/Certified app). Built exclusively for Comfort x Design's tenant. Not for redistribution.
- **Environments:** We build and test against the **sandbox/integration environment first**. Production credentials are added only after the full flow (extraction → PO creation/auto-receive) has been validated end-to-end in sandbox.
- **Sandbox and production use separate Client ID/Secret pairs.** Never reuse a sandbox credential in production or vice versa — they are different app registrations against different environments.
- **API scopes granted to this app:**
  - Purchase Orders — Read/Write
  - Vendors — Read/Write
  - Receipts — Read/Write
  - Inventory Bills — Read only
  - Pricebook Categories / Equipment / Materials — Read only

  Note: the Receipts scope was granted before it was confirmed that no receive endpoint exists (see correction above). It's likely unused by this tool, but left as-is unless it turns out to be needed for something else (e.g. reading receipt records after the fact).

### Open Questions (need client confirmation before production)

- [x] **Receive-via-API / auto-bill** — FULLY CONFIRMED, and confirmed differently than first assumed (see correction above). Resolved: create the PO with an Automatically-Receive PO Type; there is no separate receive call.
- [ ] **Invoice → project number matching** — mostly resolved for Arco-style invoices: every sample invoice carries a consistent `Cost to Location: J700.15`-style footer line (also mirrored in header fields `JOB#`/`ID#`), a fixed-position structured field rather than free text. Still needs confirming that the equivalent field is equally consistent across the other 2 vendors once their samples arrive.
- [ ] **Line-item → pricebook matching** — a real open decision, not resolved by invoice-format consistency. Arco's line items use their own part numbers and generic descriptions (e.g. `301/D`, `"GALV ELBOW 6\" - 30GA"`) that won't match ServiceTitan pricebook SKUs directly. Needs a decision: build a real mapping table, or push materials through as a generic line item with the vendor description kept as a memo/note. Worth asking Kd how she currently handles this in her manual entry.
- [x] **Tax handling** — CONFIRMED invoice-level (not per-line-item), based on a real Arco sample. `buildPoPayload()` puts tax on the PO, not per line item.
- [ ] **Vendor ID lookup** — `findVendorByName()` hits a plausible `GET /inventory/v2/tenant/{tenant}/vendors?name=` endpoint — unverified against the live API reference, confirm exact path/query param once developer access is available.
- [ ] **Job/project ID lookup** — `findJobByProjectNumber()` is not implemented. Will likely call the JPM API's Projects or Jobs list endpoint and match on a project number field; exact field name needs confirming against Comfort x Design's real data. This currently blocks `/api/create-po` from completing (it 501s at this step).
- [ ] **Business Unit ID** — no lookup logic exists at all. Currently collected as a manual input in the review table. Decide whether this needs to be resolved automatically (e.g. always one fixed BU) or should stay a manual field.
- [ ] **Batch invoice delivery** — Arco's real sample arrived as **one PDF containing 18 separate invoices** (a monthly statement), not one PDF per order. Need to confirm with the client whether this is the typical delivery format — if so, `extractInvoice()` needs a batch-aware sibling (see TODO in `src/lib/extraction.ts`) that asks Claude to split the document into constituent invoices before extracting each one. This changes the intake design, so confirm before building it.
- [ ] Confirm the exact PO Type name with "Automatically Receive" enabled in the **production** tenant — the sandbox uses `"Supply House Run"`, but production may name it differently. Configurable via `SERVICETITAN_AUTO_RECEIVE_PO_TYPE_NAME` (see Environment Variables).

## Environment Variables

All of the following must be set as **Vercel environment variables** — never committed to the repo:

- `SERVICETITAN_CLIENT_ID`
- `SERVICETITAN_CLIENT_SECRET`
- `SERVICETITAN_APP_KEY`
- `SERVICETITAN_TENANT_ID`
- `SERVICETITAN_ENVIRONMENT` — `"integration"` (sandbox, default) or `"production"`
- `SERVICETITAN_AUTO_RECEIVE_PO_TYPE_NAME` — optional, defaults to `"Supply House Run"`; the name of the PO Type with "Automatically Receive" enabled (see Open Questions — production may need a different value)
- `ANTHROPIC_API_KEY`

**Important:** `.env` must be added to `.gitignore` before any credentials are ever written to disk locally. Do not commit a `.env` file at any point, even temporarily.

## Collaboration Notes

- **Matteo** is a collaborator on this repo.
- Standard workflow:
  1. Pull before starting work.
  2. Branch per feature (don't work directly on `main`).
  3. Open a PR into `main` rather than pushing directly to `main`.

## Status Checklist

- [ ] Sandbox extraction flow working (`/api/extract-invoice` reliably returns correct data from real vendor invoice PDFs, across all 3 vendors)
- [ ] Sandbox PO creation working end-to-end (`/api/create-po` successfully creates and auto-receives a PO in the ServiceTitan sandbox tenant — currently blocked on job lookup, see Open Questions)
- [x] Sandbox auto-receive/auto-bill mechanism confirmed (no Receipts API call needed — PO Type's "Automatically Receive" setting handles it at creation time)
- [ ] Vendor ID lookup verified against live sandbox API
- [ ] Job/project ID lookup implemented and verified
- [ ] Line-item → pricebook matching decision made
- [ ] Business unit resolution decided (manual vs. automatic)
- [ ] Batch invoice delivery format confirmed with client (affects whether batch-splitting extraction logic is needed)
- [ ] Client production credentials received (production Client ID/Secret/App Key/Tenant ID)
- [ ] Production PO Type name (with Automatically Receive) confirmed
- [ ] Production tested and validated (full flow run end-to-end against the client's production tenant, with a real invoice, before relying on it)
- [ ] Live for daily use
