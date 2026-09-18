# PO-Reader

## Project Purpose

PO-Reader is an internal tool built for **Comfort x Design**, a single ServiceTitan customer, to automate the invoice-to-Purchase-Order workflow for their **3 non-integrated vendors** (vendors with no direct ServiceTitan integration, so invoices are currently keyed in by hand). Arco Supply Co. is the first confirmed vendor (real sample invoice received and validated); the other 2 are expected to use a nearly identical invoice format (confirmed by the client contact, Kevin, Sept 2026).

**Flow:**
1. User drags a vendor invoice PDF into the app.
2. The Claude API extracts structured invoice data from the PDF: vendor name, invoice number, invoice date, project number, line items (description, quantity, unit price, total), tax amount, subtotal, total, plus an `extraction_confidence` rating and free-text `notes`.
3. A human reviews and corrects the extracted data in a fully editable table. Extraction is treated as a starting draft, not a pass/fail gate: `extraction_confidence` below `"high"`, a missing vendor name/project number, or no line items show a non-blocking warning banner (see `reviewWarnings` in `src/lib/servicetitan/payload-builder.ts`) but never disable the form — the user can add, remove, or correct any field, including ones the extraction missed entirely, before submitting. The only hard block is a document that isn't a vendor invoice at all (e.g. an internal memo) — see `isNotAnInvoice` — since there's no partial data worth editing in that case.
4. On confirmation, the tool resolves the ServiceTitan vendor, then creates a Purchase Order via `PurchaseOrders_Create`. Job attachment is best-effort, not required — see the note below.
5. **There is no separate "receive" step.** See the important correction below.

This is not a general-purpose product. It is built exclusively for Comfort x Design's ServiceTitan tenant and is not intended for redistribution or multi-tenant use.

### Important correction: how receiving actually works

An earlier version of this document assumed the tool would call a ServiceTitan "Receipts" endpoint after PO creation to receive the PO. **This is wrong and has been confirmed wrong against ServiceTitan's own developer docs.** Per their Inventory API resource page: *"A purchase order status cannot be updated through API."* There is no receive/status-change endpoint — full stop.

The **only** way a PO ends up `Received` (and, if enabled, auto-generates a bill) via the API is to **create it using a PO Type that has "Automatically Receive" enabled** — status and bill generation happen automatically at creation time, not via any follow-up call. In the sandbox, the PO Type named `"Supply House Run"` has this enabled. `buildPoPayload()` (`src/lib/servicetitan/payload-builder.ts`) requires a `poTypeId` for exactly this reason, and `/api/create-po` looks it up via `ServiceTitanClient.getPoTypeIdByName()`.

`ServiceTitanClient.updatePurchaseOrder()` exists in the client but is explicitly **not** for status changes — see the warning comment on that method.

### Important correction: line items need a real Pricebook skuId

An earlier version of `buildPoPayload()` (ported from the Python prototype) sent each line item as `{ skuName, quantity, price, total }`. **This is wrong** — a live `PurchaseOrders_Create` 400 confirmed the real required item properties are `cost`, `skuId`, `description`, and `vendorPartNumber`, not `price`/`skuName`. The field-name mismatch was the easy part to fix; the real issue is `skuId`: it must reference an **existing ServiceTitan Pricebook item**, not free text. Claude's extraction alone can never produce this — it has to be resolved via a lookup.

`ServiceTitanClient.findMaterialSkuIdByDescription()` does a **naive, first-pass** description-text match against Pricebook Materials (using the Read-only Pricebook scope already granted) as a stopgap so PO creation works for cleanly-matching invoices. This is explicitly NOT the real matching strategy — see the "Line-item → pricebook matching" open question below, still unresolved. `/api/create-po` now fails with a clear `422` naming exactly which line-item descriptions had no Pricebook match, rather than either guessing a SKU or letting the raw ServiceTitan 400 surface confusingly.

`ExtractedInvoice`'s line items also gained a `vendorPartNumber` field (the vendor's own part code, e.g. Arco's `"301/D"`) since ServiceTitan requires it per item — this is separate from, and does NOT help resolve, the Pricebook `skuId`.

### Job attachment is optional, not required

These invoices are for **general inventory/bulk restock purchases**, not tied to specific jobs — this is the expected norm, pending final confirmation from the client on whether any of their invoices actually ARE job-tied. `PurchaseOrders_Create` proceeds using just vendor, line items, and Business Unit ID when no job is attached; `jobId` is omitted from the payload entirely rather than sent as null/undefined (see `buildPoPayload()`).

If the invoice has a project number, `/api/create-po` still attempts `findJobByProjectNumber()` and attaches the job if one is found (some invoices may reference a job even in an otherwise bulk-purchase context) — but a missing project number, a failed lookup, or no matching job never blocks PO creation. `findJobByProjectNumber()` itself is still unimplemented (throws), so in practice every lookup today falls through to "proceed without a job" — this is caught and logged as a warning, not surfaced as an error.

## Architecture

- **Framework:** Next.js, deployed to Vercel.
- **App Router** is used for routing.

### Core library code (`src/lib/`)

This logic was ported from an earlier Python prototype (`comfort-x-design-invoice-tool`) that was validated against a real Arco Supply invoice sample — it isn't from-scratch/unvalidated code, and the TODOs below reflect genuine open items from that prototype, not just caution.

- **`src/lib/types.ts`** — `ExtractedInvoice` / `InvoiceLineItem`, the shape that flows extraction → review table → PO creation.
- **`src/lib/extraction.ts`** — `extractInvoice(pdfBuffer)`: sends the PDF to Claude with a defined extraction prompt/JSON schema, parses and normalizes the response into `ExtractedInvoice`.
- **`src/lib/servicetitan/client.ts`** — `ServiceTitanClient`: OAuth2 `client_credentials` token fetch/cache, `createPurchaseOrder`, `getPoTypeIdByName`, `findVendorByName`. `findJobByProjectNumber` is **not implemented** — throws, pending JPM API research (see Open Questions). Its caller in `/api/create-po` treats that as "no job found" rather than an error, since job attachment is best-effort (see above).
- **`src/lib/servicetitan/payload-builder.ts`** — `buildPoPayload()` converts an `ExtractedInvoice` + resolved IDs into the `PurchaseOrders_Create` request body; `jobId` is optional and omitted from the payload when not provided. Three review/guardrail functions, all pure (safe to call from client or server code): `reviewWarnings()` / `needsHumanReview()` are non-blocking — they surface a warning banner but never disable submission; `isNotAnInvoice()` is the one hard-block gate (document isn't a vendor invoice at all); `hasRequiredFields()` is the actual submission gate (vendor name and at least one valid line item present — project number is deliberately NOT required, regardless of confidence or how the data got there).

### API Routes

- **`/api/extract-invoice`**
  Accepts a PDF upload (`multipart/form-data`, field `file`), calls `extractInvoice()`, returns the structured `ExtractedInvoice`.

- **`/api/create-po`**
  Takes the human-reviewed `ExtractedInvoice` (plus a `businessUnitId` — see below), resolves the ServiceTitan vendor (`findVendorByName` — required), best-effort resolves a job via `findJobByProjectNumber` when a project number is present (never blocks — see Job attachment above), resolves the auto-receive PO Type ID, builds the payload, and calls `PurchaseOrders_Create`. Re-runs `isNotAnInvoice` and `hasRequiredFields` server-side as defense in depth even though the frontend should already gate on the same checks — does NOT re-check confidence, since low confidence is not a submission blocker (see Flow above).

  **`businessUnitId` comes from the review table's Business Unit dropdown** (see Frontend below), populated via `GET /api/business-units`.

- **`/api/business-units`**
  `GET` — calls `ServiceTitanClient.listBusinessUnits()` and returns `[{ id, name }, ...]`. Backs the review table's Business Unit dropdown; the user picks a name, never types or sees a raw ID. Supersedes an earlier temporary `/api/dev/business-units` scratch route (now deleted) that was sandbox-only — this one is permanent and has no environment restriction, since Business Unit selection is needed in every environment.

### Frontend

- **Upload screen** (`src/components/InvoiceUploader.tsx`) — file picker for the vendor invoice PDF (drag-and-drop is a TODO), drives the upload → extract → review → submit state machine, kicks off `/api/extract-invoice`.
- **Review table** (`src/components/ReviewTable.tsx`) — shown between extraction and submission. This is the human-in-the-loop checkpoint: nothing is written to ServiceTitan until the user confirms/corrects the extracted data and picks a Business Unit from the dropdown (fetched from `/api/business-units` on mount; if only one Business Unit exists, it's pre-selected automatically but still shown, not hidden). Surfaces the `needsHumanReview` flag as a visible warning. Submission calls `/api/create-po`.

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
  - Pricebook Categories / Equipment / Materials — Read only (now actively used by `findMaterialSkuIdByDescription()` for the line-item skuId lookup -- see the important correction above)

  Note: the Receipts scope was granted before it was confirmed that no receive endpoint exists (see correction above). It's likely unused by this tool, but left as-is unless it turns out to be needed for something else (e.g. reading receipt records after the fact).

### Open Questions (need client confirmation before production)

- [x] **Receive-via-API / auto-bill** — FULLY CONFIRMED, and confirmed differently than first assumed (see correction above). Resolved: create the PO with an Automatically-Receive PO Type; there is no separate receive call.
- [ ] **Invoice → project number matching** — mostly resolved for Arco-style invoices: every sample invoice carries a consistent `Cost to Location: J700.15`-style footer line (also mirrored in header fields `JOB#`/`ID#`), a fixed-position structured field rather than free text. Still needs confirming that the equivalent field is equally consistent across the other 2 vendors once their samples arrive.
- [ ] **Line-item → pricebook matching** — a real open decision, not resolved by invoice-format consistency. Arco's line items use their own part numbers and generic descriptions (e.g. `301/D`, `"GALV ELBOW 6\" - 30GA"`) that won't match ServiceTitan pricebook SKUs directly. Needs a decision: build a real mapping table, or push materials through as a generic line item with the vendor description kept as a memo/note. Worth asking Kd how she currently handles this in her manual entry. **This is now a hard requirement, not just a nice-to-have**: a live `PurchaseOrders_Create` 400 confirmed each `items[]` entry requires a real `skuId` referencing an existing Pricebook item, or the whole PO creation fails. `ServiceTitanClient.findMaterialSkuIdByDescription()` does a naive description-text match against Pricebook Materials as a stopgap (`/api/create-po` fails clearly, listing unmatched descriptions, rather than guessing) — this is explicitly a placeholder, not the real strategy this bullet is still asking for.
- [x] **Tax handling** — CONFIRMED invoice-level (not per-line-item), based on a real Arco sample. `buildPoPayload()` puts tax on the PO, not per line item.
- [ ] **Vendor ID lookup** — `findVendorByName()` hits a plausible `GET /inventory/v2/tenant/{tenant}/vendors?name=` endpoint — unverified against the live API reference, confirm exact path/query param once developer access is available.
- [ ] **Job/project ID lookup** — `findJobByProjectNumber()` is not implemented. Will likely call the JPM API's Projects or Jobs list endpoint and match on a project number field; exact field name needs confirming against Comfort x Design's real data. **No longer blocks `/api/create-po`** — job attachment is best-effort/optional (these are mostly bulk/inventory purchases, not job-tied), so this is worth implementing for the minority of invoices that ARE job-tied, but not a launch blocker. Still pending final client confirmation on whether any of their invoices are actually job-tied at all.
- [x] **Business Unit ID** — resolved via a dropdown (`GET /api/business-units` → `ServiceTitanClient.listBusinessUnits()`) in the review table; the user picks a name, never a raw ID. Still worth revisiting once production access exists: the underlying `/settings/v2/tenant/{tenant}/business-units` endpoint is unverified against live docs (see `listBusinessUnits()` in `src/lib/servicetitan/client.ts`), and it's not yet confirmed whether Comfort x Design uses one Business Unit or several.
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
- [ ] Sandbox PO creation working end-to-end (`/api/create-po` successfully creates and auto-receives a PO in the ServiceTitan sandbox tenant — no longer blocked on job lookup, since job attachment is optional; still depends on vendor lookup and pricebook `skuId` matching both succeeding, see below)
- [x] Sandbox auto-receive/auto-bill mechanism confirmed (no Receipts API call needed — PO Type's "Automatically Receive" setting handles it at creation time)
- [x] Job attachment confirmed optional (bulk/inventory purchases, not job-tied) — pending final client confirmation on whether ANY invoices are job-tied
- [ ] Vendor ID lookup verified against live sandbox API
- [ ] Job/project ID lookup implemented and verified (best-effort, not a launch blocker)
- [ ] Line-item → pricebook matching decision made (naive description-text stopgap in place via `findMaterialSkuIdByDescription()` — PO creation works for cleanly-matching items, but the real matching strategy is still undecided; a live 400 confirmed `skuId` is hard-required per item)
- [x] Business unit resolution decided (dropdown via `/api/business-units`, not manual entry) — still needs `listBusinessUnits()`'s endpoint verified against live sandbox API
- [ ] Batch invoice delivery format confirmed with client (affects whether batch-splitting extraction logic is needed)
- [ ] Client production credentials received (production Client ID/Secret/App Key/Tenant ID)
- [ ] Production PO Type name (with Automatically Receive) confirmed
- [ ] Production tested and validated (full flow run end-to-end against the client's production tenant, with a real invoice, before relying on it)
- [ ] Live for daily use
