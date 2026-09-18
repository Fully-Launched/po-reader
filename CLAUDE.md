# PO-Reader

## Project Purpose

PO-Reader is an internal tool built for a single ServiceTitan customer to automate vendor invoice entry. It removes the manual work of re-keying vendor invoices into ServiceTitan as Purchase Orders.

**Flow:**
1. User drags a vendor invoice PDF into the app.
2. The Claude API extracts structured line items from the PDF (vendor name, description, quantity, unit cost, total).
3. A human reviews and corrects the extracted data in an editable table.
4. On confirmation, the tool creates a Purchase Order in ServiceTitan via API.
5. The tool then calls the ServiceTitan Receipts endpoint to receive the PO.
6. Receiving the PO triggers ServiceTitan's built-in auto-bill-creation — **but only if that setting is enabled on the client's account** (see open questions below). If not enabled, receiving still happens automatically, but bill creation will need a manual step on the client's end.

This is not a general-purpose product. It is built exclusively for one client's ServiceTitan tenant and is not intended for redistribution or multi-tenant use.

## Architecture

- **Framework:** Next.js, deployed to Vercel.
- **App Router** is used for routing.

### API Routes

- **`/api/extract-invoice`**
  Accepts a PDF upload from the frontend, sends it to the Claude API along with a defined JSON schema (vendor name + line items: description, quantity, unit cost, total), and returns the structured extraction result.

- **`/api/create-po`**
  Handles the ServiceTitan OAuth2 `client_credentials` flow (fetching/caching an access token), calls the ServiceTitan `PurchaseOrders_Create` endpoint with the confirmed line items, then calls the Receipts creation endpoint to receive the newly created PO.

### Frontend

- **Upload screen** — drag-and-drop (or file picker) for the vendor invoice PDF, kicks off `/api/extract-invoice`.
- **Review table** — an editable table shown between extraction and submission. This is the human-in-the-loop checkpoint: nothing is written to ServiceTitan until the user confirms/corrects the extracted vendor name and line items in this table. Submission from this table calls `/api/create-po`.

The review table is a deliberate design choice, not a placeholder to be removed later — Claude's extraction is not assumed to be perfect, and ServiceTitan PO/receipt creation is not something we want to auto-fire on unverified data.

## ServiceTitan Integration Specifics

- **App type:** Customer-Built App (not a Marketplace/Certified app). Built exclusively for one client's tenant. Not for redistribution.
- **Environments:** We build and test against the **sandbox/integration environment first**. Production credentials are added only after the full flow (extraction → PO creation → receiving → auto-bill) has been validated end-to-end in sandbox.
- **Sandbox and production use separate Client ID/Secret pairs.** Never reuse a sandbox credential in production or vice versa — they are different app registrations against different environments.
- **API scopes granted to this app:**
  - Purchase Orders — Read/Write
  - Vendors — Read/Write
  - Receipts — Read/Write
  - Inventory Bills — Read only
  - Pricebook Categories / Equipment / Materials — Read only

### Open Questions (need client confirmation before production)

These directly determine whether the receiving step results in a fully automated bill or requires a manual step on the client's side:

- [ ] Does the client's PO type support auto-receive?
- [ ] Is "Automatically create bill when PO is received" enabled in the client's Inventory Configuration settings?

Do not assume either of these is true. If they turn out to be false/unsupported, the tool's receiving step will still succeed, but the client will need to manually create the bill from the received PO in ServiceTitan.

## Environment Variables

All of the following are required and must be set as **Vercel environment variables** — never committed to the repo:

- `SERVICETITAN_CLIENT_ID`
- `SERVICETITAN_CLIENT_SECRET`
- `SERVICETITAN_APP_KEY`
- `SERVICETITAN_TENANT_ID`
- `ANTHROPIC_API_KEY`

**Important:** `.env` must be added to `.gitignore` in the very first commit to this repo, before any credentials are ever written to disk locally. Do not commit a `.env` file at any point, even temporarily.

## Collaboration Notes

- **Matteo** is a collaborator on this repo.
- Standard workflow:
  1. Pull before starting work.
  2. Branch per feature (don't work directly on `main`).
  3. Open a PR into `main` rather than pushing directly to `main`.

## Status Checklist

- [ ] Sandbox extraction flow working (`/api/extract-invoice` reliably returns correct vendor + line items from real vendor invoice PDFs)
- [ ] Sandbox PO creation working (`/api/create-po` successfully creates a PO in the ServiceTitan sandbox tenant)
- [ ] Sandbox receiving/auto-bill confirmed (Receipts call succeeds in sandbox, and we've confirmed whether it triggers auto-bill-creation or needs a manual step)
- [ ] Client production credentials received (production Client ID/Secret/App Key/Tenant ID from the client)
- [ ] Production tested and validated (full flow run end-to-end against the client's production tenant, with a real invoice, before relying on it)
- [ ] Live for daily use
