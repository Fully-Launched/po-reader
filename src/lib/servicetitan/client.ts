// Minimal ServiceTitan API client: auth + the calls this tool needs.
//
// Ported from the comfort-x-design-invoice-tool prototype's
// servicetitan/client.py. Verify every endpoint path/schema against
// developer.servicetitan.io before going live -- several of these are
// written from the publicly documented shape of the Inventory API, not from
// a live-tested account (flagged per-method below).

const AUTH_URLS: Record<string, string> = {
  integration: "https://auth-integration.servicetitan.io/connect/token",
  production: "https://auth.servicetitan.io/connect/token",
};

const API_BASES: Record<string, string> = {
  integration: "https://api-integration.servicetitan.io",
  production: "https://api.servicetitan.io",
};

interface PoType {
  id: number;
  name: string;
}

interface Vendor {
  id: number;
  name: string;
  [key: string]: unknown;
}

interface BusinessUnit {
  id: number;
  name: string;
  [key: string]: unknown;
}

interface PricebookMaterial {
  id: number;
  displayName?: string;
  code?: string;
  [key: string]: unknown;
}

interface InventoryLocation {
  id: number;
  name: string;
  [key: string]: unknown;
}

interface Job {
  id: number;
  number?: string;
  [key: string]: unknown;
}

export class ServiceTitanClient {
  private environment: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private appKey: string;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.environment = process.env.SERVICETITAN_ENVIRONMENT ?? "integration";
    this.tenantId = requireEnv("SERVICETITAN_TENANT_ID");
    this.clientId = requireEnv("SERVICETITAN_CLIENT_ID");
    this.clientSecret = requireEnv("SERVICETITAN_CLIENT_SECRET");
    this.appKey = requireEnv("SERVICETITAN_APP_KEY");
  }

  /** Fetch (and cache) an OAuth 2.0 client-credentials access token. */
  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const resp = await fetch(AUTH_URLS[this.environment], {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!resp.ok) {
      throw new Error(`ServiceTitan auth failed: ${resp.status} ${await resp.text()}`);
    }
    const payload = await resp.json();

    this.token = payload.access_token;
    // Refresh a little early to avoid edge-of-expiry failures
    this.tokenExpiresAt = Date.now() + ((payload.expires_in ?? 900) - 60) * 1000;
    return this.token as string;
  }

  private async headers(): Promise<HeadersInit> {
    return {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      "ST-App-Key": this.appKey,
      "Content-Type": "application/json",
    };
  }

  /**
   * Create a Purchase Order via the Inventory API.
   * Docs: https://developer.servicetitan.io/api-details/#api=tenant-inventory-v2&operation=PurchaseOrders_Create
   */
  async createPurchaseOrder(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${API_BASES[this.environment]}/inventory/v2/tenant/${this.tenantId}/purchase-orders`;
    const body = JSON.stringify(payload);
    // Logged unconditionally while shipTo/shipping/request are still being
    // pinned down against live 400s -- gives the exact bytes ServiceTitan
    // received, not just the JS object, so a failure can be diagnosed against
    // the real request rather than a guess. Revisit once the payload shape is
    // confirmed stable.
    console.log(`PurchaseOrders_Create request body (${body.length} chars):`, body);
    const resp = await fetch(url, {
      method: "POST",
      headers: await this.headers(),
      body,
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`PurchaseOrders_Create failed: ${resp.status}`, errorText);
      throw new Error(`PurchaseOrders_Create failed: ${resp.status} ${errorText}`);
    }
    return resp.json();
  }

  /**
   * DO NOT USE FOR STATUS CHANGES. CONFIRMED via ServiceTitan's own developer
   * docs (Inventory API resource page): "A purchase order status cannot be
   * updated through API." There is no receive/status-change endpoint -- this
   * was fully resolved, not just suspected. The ONLY way to get a PO
   * auto-received via the API is to create it using a PO Type with
   * "Automatically Receive" enabled (see getPoTypeIdByName below) -- the
   * status is set automatically at creation time, not updated afterward.
   * This method is kept only for non-status fields that may be genuinely
   * editable (e.g. memo) -- verify against the live reference before relying
   * on it for anything.
   */
  async updatePurchaseOrder(
    poId: number,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${API_BASES[this.environment]}/inventory/v2/tenant/${this.tenantId}/purchase-orders/${poId}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify(updates),
    });
    if (!resp.ok) {
      throw new Error(`updatePurchaseOrder failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json();
  }

  /**
   * Look up a Purchase Order Type's ID by name (e.g. "Supply House Run",
   * which has Automatically Receive enabled in the sandbox). "Automatically
   * Receive" is a setting configured on the PO Type itself in ServiceTitan's
   * own UI (on the client's account) -- this method, and this app generally,
   * never sets or controls that setting; it only looks up which existing,
   * already-configured PO Type to reference by ID. Endpoint CONFIRMED
   * working via a live PO creation (PO #19969, sandbox).
   */
  async getPoTypeIdByName(typeName: string): Promise<number | null> {
    const url = `${API_BASES[this.environment]}/inventory/v2/tenant/${this.tenantId}/purchase-order-types`;
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) {
      throw new Error(`getPoTypeIdByName failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    const match = (body.data ?? []).find(
      (poType: PoType) => poType.name?.toLowerCase() === typeName.toLowerCase(),
    );
    return match?.id ?? null;
  }

  /**
   * Look up a ServiceTitan VendorId by name.
   * Endpoint (unverified against live docs, but plausible given API module
   * structure): GET /inventory/v2/tenant/{tenant}/vendors, filtered by name.
   * Confirm exact query param name (e.g. ?name=) once developer access is available.
   */
  async findVendorByName(vendorName: string): Promise<Vendor | null> {
    const url = new URL(`${API_BASES[this.environment]}/inventory/v2/tenant/${this.tenantId}/vendors`);
    url.searchParams.set("name", vendorName);
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) {
      throw new Error(`findVendorByName failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    const results: Vendor[] = body.data ?? [];
    return results[0] ?? null;
  }

  /**
   * List Business Units for this tenant -- backs the review table's Business
   * Unit dropdown via GET /api/business-units. Endpoint (unverified against
   * live docs, but plausible given the Settings API's module structure):
   * GET /settings/v2/tenant/{tenant}/business-units. Fetches a single page
   * (pageSize 200) rather than following pagination -- fine while the
   * tenant has a small number of BUs, revisit if that stops being true.
   */
  async listBusinessUnits(): Promise<BusinessUnit[]> {
    const url = new URL(`${API_BASES[this.environment]}/settings/v2/tenant/${this.tenantId}/business-units`);
    url.searchParams.set("pageSize", "200");
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) {
      throw new Error(`listBusinessUnits failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    return body.data ?? [];
  }

  /**
   * Look up a ServiceTitan Pricebook Material's skuId by matching on its
   * name/description. REQUIRED for PurchaseOrders_Create -- ServiceTitan's
   * items[] schema rejects a line item with a 400 ("required properties
   * cost, skuId, description, and vendorPartNumber are missing") unless
   * skuId references a real Pricebook item; free text alone isn't accepted.
   *
   * This is a NAIVE first-pass matcher: exact/best-effort text match against
   * whatever Claude extracted as the line item description. It is NOT the
   * real matching strategy -- see CLAUDE.md "Line-item -> pricebook
   * matching", still an open decision (exact-match mapping table vs. fuzzy
   * matching vs. a generic catch-all SKU for anything unmatched). Treat this
   * as a placeholder that makes PO creation work for cleanly-matching items,
   * not a finished solution.
   *
   * Endpoint (unverified against live docs, but plausible given the
   * Pricebook API's module structure; uses the Read-only Pricebook
   * Materials/Equipment scope already granted -- see CLAUDE.md scopes):
   * GET /pricebook/v2/tenant/{tenant}/materials, filtered by name.
   */
  async findMaterialSkuIdByDescription(description: string): Promise<number | null> {
    const url = new URL(`${API_BASES[this.environment]}/pricebook/v2/tenant/${this.tenantId}/materials`);
    url.searchParams.set("name", description);
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) {
      throw new Error(`findMaterialSkuIdByDescription failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    const results: PricebookMaterial[] = body.data ?? [];
    return results[0]?.id ?? null;
  }

  /**
   * List Inventory Locations for this tenant -- backs the review table's
   * Inventory Location dropdown via GET /api/inventory-locations.
   * PurchaseOrders_Create requires inventoryLocationId as a top-level field
   * (confirmed via a live 400 once item-level validation started passing).
   *
   * CORRECTED: the original guess (GET .../inventory-locations) 404'd with
   * "Unable to match incoming request to an operation" -- that resource
   * doesn't exist. Researched properly this time rather than guessing again:
   *   - developer.servicetitan.io's API reference is a JS-rendered SPA that
   *     can't be fetched directly (same problem as the shipTo/shipping
   *     research earlier), so it couldn't be checked directly.
   *   - A third-party API profile (grokipedia.com/page/ServiceTitan_API_scopes)
   *     independently describes an Inventory API "Warehouses" scope for
   *     "inventory sites tied to locations" -- i.e. what ServiceTitan's own
   *     product UI calls "Inventory Locations" is the "Warehouses" resource
   *     in the API.
   *   - A reconstructed OpenAPI spec (github.com/api-evangelist/servicetitan,
   *     openapi/_original/servicetitan-inventory-api-openapi.yml) independently
   *     lists a GET /warehouses operation under the Inventory API, tags:
   *     [Purchase Orders, Vendors, Warehouses, Trucks, Adjustments, Transfers,
   *     Returns, Receipts] -- no separate "inventory-locations" resource at all.
   *
   * Two independent sources agreeing on "Warehouses" is real evidence, not
   * just a repeated guess -- but neither is ServiceTitan's own live schema,
   * and that second spec's own PurchaseOrders_Create schema uses a
   * DIFFERENT field name (warehouseId) than what our live 400 actually
   * confirmed (inventoryLocationId) -- proof that spec doesn't fully match
   * the real current API, so treat the exact response shape below as a
   * guess too, not just the path. Path assembled by swapping the resource
   * segment onto our own ALREADY-CONFIRMED-WORKING tenant-scoped URL
   * convention (/inventory/v2/tenant/{tenant}/... -- confirmed working
   * because PurchaseOrders_Create reaches real field validation, not a 404,
   * on that exact path pattern), rather than trusting the third-party
   * spec's own (differently-shaped, tenant-segment-less) server URL.
   *
   * STILL NOT LIVE-VERIFIED. Test against the sandbox tenant before relying
   * on this.
   */
  async listInventoryLocations(): Promise<InventoryLocation[]> {
    const url = new URL(`${API_BASES[this.environment]}/inventory/v2/tenant/${this.tenantId}/warehouses`);
    url.searchParams.set("pageSize", "200");
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) {
      throw new Error(`listInventoryLocations failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    return body.data ?? [];
  }

  /**
   * Look up a ServiceTitan Job by its Job Number, matching the invoice's
   * extracted project number. Job attachment is now REQUIRED, not
   * best-effort (CONFIRMED on a client call: Kevin is switching his invoice
   * PO numbering to use the project number directly as the Job Number going
   * forward) -- so this must actually work, not just be a stub.
   *
   * RESEARCHED with the same rigor as listInventoryLocations()'s warehouse
   * research: developer.servicetitan.io is a JS-rendered SPA and couldn't be
   * fetched directly, so this is built from cross-referencing THREE
   * independent third-party sources rather than a single unverified guess:
   *   1. A reconstructed OpenAPI spec (github.com/api-evangelist/servicetitan,
   *      openapi/servicetitan-jobs-api-openapi.yml) shows GET /jobs
   *      supporting only page/pageSize/modifiedOnOrAfter/jobStatus query
   *      params -- no job-number or project-number filter. (Its base URL/title
   *      for this file are clearly mislabeled -- "Accounting Adjustments Jobs
   *      API" at an /accounting/v2/ base -- an artifact of this generator's
   *      auto-reconstruction, not to be trusted for the base path.)
   *   2. An independently-built, actively-maintained open-source ServiceTitan
   *      CLI (github.com/utkukaynar/Unofficial-ServiceTitan-CLI-MCP,
   *      src/st_cli/commands/jobs.py, module "jpm") exposes the same limited
   *      filter set (status, customerId, date range) for `jobs list` -- also
   *      no number-based filter -- and names the field "number", not
   *      "jobNumber" as source #1 guessed.
   *   3. Prismatic's ServiceTitan connector docs (prismatic.io/docs/components/servicetitan)
   *      confirm the same for both Jobs and Projects: "List Jobs"/"List
   *      Projects" expose no dedicated job-number/project-number filter
   *      parameter, only generic custom query params.
   *
   * All three independently agree on the same conclusion: there is no
   * documented server-side way to look up a Job by number. This method
   * therefore PAGINATES through GET /jpm/v2/tenant/{tenant}/jobs (base path
   * per source #2's "jpm" module, ServiceTitan's well-known JPM API base) and
   * matches client-side on job.number -- a real limitation (not a targeted
   * lookup) given a tenant's jobs list is unbounded. Capped at MAX_PAGES to
   * avoid a runaway loop; logs a warning and returns null if the cap is hit
   * without a match rather than looping forever.
   *
   * A Job vs. Project distinction is also unresolved: ServiceTitan has a
   * separate Projects resource with its OWN "number" field (source #1/#3),
   * and Jobs can belong to a Project -- but neither reconstructed schema
   * shows a projectId-style link on Job, so this method matches directly
   * against Job.number, consistent with this function's existing name/
   * purpose and with PurchaseOrders_Create requiring a jobId (not a
   * projectId) directly.
   *
   * STILL NOT LIVE-VERIFIED. Test against the sandbox tenant before relying
   * on this in production -- and worth testing an undocumented `?number=`
   * query param directly against a live call, since ServiceTitan endpoints
   * sometimes support filters absent from these third-party reconstructions.
   */
  async findJobByProjectNumber(projectNumber: string): Promise<{ id: number; number?: string } | null> {
    const MAX_PAGES = 20;
    const PAGE_SIZE = 100;
    const target = projectNumber.trim().toLowerCase();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(`${API_BASES[this.environment]}/jpm/v2/tenant/${this.tenantId}/jobs`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      const resp = await fetch(url, { headers: await this.headers() });
      if (!resp.ok) {
        throw new Error(`findJobByProjectNumber failed: ${resp.status} ${await resp.text()}`);
      }
      const body = await resp.json();
      const jobs: Job[] = body.data ?? [];

      // DIAGNOSTIC LOGGING (temporary -- live testing confirmed
      // findJobByProjectNumber fails to match real sandbox job numbers
      // visible in ServiceTitan's own Purchase Orders "Job No." column,
      // e.g. 1817/2117). Logged only on page 1 to avoid spamming: the raw
      // shape of one job object, so the ACTUAL field name ServiceTitan uses
      // for job number can be confirmed (this code currently guesses
      // "number" -- may be wrong, e.g. "jobNumber" as an earlier
      // cross-referenced source guessed), plus totalCount/hasMore, to check
      // whether pagination could be missing jobs entirely. Remove once the
      // real field name is confirmed and the match logic below is fixed.
      if (page === 1) {
        console.log("findJobByProjectNumber: first page totalCount/hasMore/pageSize:", {
          totalCount: body.totalCount,
          hasMore: body.hasMore,
          page: body.page,
          pageSize: body.pageSize,
          jobsReturned: jobs.length,
        });
        console.log("findJobByProjectNumber: first job object (raw, full shape):", JSON.stringify(jobs[0], null, 2));
      }

      const match = jobs.find((job) => job.number?.trim().toLowerCase() === target);
      if (match) {
        return { id: match.id, number: match.number };
      }
      if (!body.hasMore) {
        return null;
      }
    }
    console.warn(
      `findJobByProjectNumber: gave up after ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} jobs) without finding a match for "${projectNumber}"`,
    );
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
