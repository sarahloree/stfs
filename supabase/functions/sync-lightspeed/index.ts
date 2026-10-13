// =====================================================================
// STFS — Lightspeed Sync (Supabase Edge Function)
// Build stamp: 2026-07-16a
//
// SCOPE: catalog + stock only.
//   outlets -> suppliers -> customers -> products -> product_suppliers -> inventory
//
// Quotes, sales and consignments are deliberately NOT here. They are
// historical and will still be there next week. These five are the ones
// that feed product_cost_history and inventory_history, which build
// FORWARD ONLY and cannot be backfilled — every day this does not run is
// a day of history that will never exist.
//
// SECRETS REQUIRED (supabase secrets set ...):
//   LIGHTSPEED_DOMAIN   e.g. southtexasfencesupply
//   LIGHTSPEED_TOKEN    the personal token
//   LIGHTSPEED_API_VER  e.g. 2026-01
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// INVOCATION:
//   POST with no body            -> incremental (since last good version)
//   POST {"full": true}          -> full resync, ignores cursor
//
// DESIGN NOTES
//   * The mirror is FAITHFUL. source='SYSTEM' rows (the "Discount"
//     pseudo-product) are stored, not filtered. Filtering happens in
//     views. If we filter on the way in, the mirror stops being a mirror.
//   * Everything upserts on the Lightspeed ID. No plain inserts, ever —
//     this is the discipline that fixed the commission dashboard's
//     duplicate rows.
//   * Lightspeed's `version` is a monotonic change marker and doubles as
//     the pagination cursor AND the incremental cursor. Same mechanism,
//     no extra bookkeeping.
//   * Rate limiting is a leaky bucket (~60 units, reads cost ~1), NOT the
//     X-RateLimit headers the directive named — those belong to the auth
//     endpoint. We pace politely and back off hard on 429.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const DOMAIN = Deno.env.get("LIGHTSPEED_DOMAIN")!;
const TOKEN = Deno.env.get("LIGHTSPEED_TOKEN")!;
const API_VER = Deno.env.get("LIGHTSPEED_API_VER") ?? "2026-01";
const BASE = `https://${DOMAIN}.retail.lightspeed.app/api/${API_VER}`;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const PAGE_SIZE = 500;
const PAGE_PAUSE_MS = 250;   // stay well inside the bucket
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------
// HTTP with rate-limit backoff
// ---------------------------------------------------------------------
async function lsGet(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const url = `${BASE}/${path}?${qs}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      // Leaky bucket empty. Back off exponentially; respect Retry-After
      // if Lightspeed gives us one.
      const retryAfter = Number(res.headers.get("Retry-After") ?? 0);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} -> ${res.status}: ${body.slice(0, 400)}`);
    }

    return await res.json();
  }
  throw new Error(`GET ${path} -> gave up after ${MAX_RETRIES} rate-limit retries`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Paginate an endpoint using `version` as the cursor.
// Lightspeed returns { data: [...], version: { min, max } }.
// `after` is the highest version we have already seen.
// ---------------------------------------------------------------------
async function* paginate(path: string, after: number) {
  let cursor = after;
  while (true) {
    const body = await lsGet(path, { page_size: PAGE_SIZE, after: cursor });
    const rows = body?.data ?? [];
    if (rows.length === 0) return;

    yield rows;

    const max = Number(body?.version?.max ?? 0);
    // No forward movement means we have drained the endpoint.
    if (!max || max <= cursor) return;
    cursor = max;

    if (rows.length < PAGE_SIZE) return;
    await sleep(PAGE_PAUSE_MS);
  }
}

// ---------------------------------------------------------------------
// sync_log helpers
// ---------------------------------------------------------------------
async function logStart(runId: string, entity: string) {
  const { data } = await db.from("sync_log")
    .insert({ run_id: runId, entity, status: "running", api_version: API_VER })
    .select("id").single();
  return data?.id as number;
}

async function logFinish(
  id: number,
  status: string,
  seen: number,
  upserted: number,
  cursorVersion: number | null,
  error?: string,
) {
  await db.from("sync_log").update({
    finished_at: new Date().toISOString(),
    status,
    records_seen: seen,
    records_upserted: upserted,
    cursor_version: cursorVersion,
    error_text: error ?? null,
  }).eq("id", id);
}

// Highest version successfully synced for an entity — the incremental cursor.
// Read from the last SUCCESSFUL run, so a failure never advances the cursor
// past records we did not actually store.
async function lastCursor(entity: string, full: boolean): Promise<number> {
  if (full) return 0;
  const { data } = await db.from("sync_log")
    .select("cursor_version")
    .eq("entity", entity).eq("status", "success")
    .not("cursor_version", "is", null)
    .order("started_at", { ascending: false }).limit(1);
  if (!data || data.length === 0) return 0;
  return Number(data[0].cursor_version ?? 0);
}

// ---------------------------------------------------------------------
// OUTLETS
// ---------------------------------------------------------------------
async function syncOutlets(runId: string, full: boolean) {
  const logId = await logStart(runId, "outlets");
  let seen = 0, up = 0, maxV = await lastCursor("outlets", full);
  try {
    for await (const rows of paginate("outlets", maxV)) {
      seen += rows.length;
      const mapped = rows.map((o: any) => ({
        outlet_id: o.id,
        name: o.name,
        time_zone: o.time_zone ?? null,
        deleted_at: o.deleted_at,
        ls_version: o.version ?? null,
        raw: o,
        synced_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      }));
      const { error } = await db.from("ls_outlets")
        .upsert(mapped, { onConflict: "outlet_id" });
      if (error) throw new Error(error.message);
      up += mapped.length;
      maxV = Math.max(maxV, ...rows.map((r: any) => Number(r.version ?? 0)));
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up };
}

// ---------------------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------------------
async function syncSuppliers(runId: string, full: boolean) {
  const logId = await logStart(runId, "suppliers");
  let seen = 0, up = 0, maxV = await lastCursor("suppliers", full);
  try {
    for await (const rows of paginate("suppliers", maxV)) {
      seen += rows.length;
      const mapped = rows.map((s: any) => ({
        supplier_id: s.id,
        name: s.name,
        description: s.description ?? null,
        deleted_at: s.deleted_at,
        ls_version: s.version ?? null,
        raw: s,
        synced_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      }));
      const { error } = await db.from("ls_suppliers")
        .upsert(mapped, { onConflict: "supplier_id" });
      if (error) throw new Error(error.message);
      up += mapped.length;
      maxV = Math.max(maxV, ...rows.map((r: any) => Number(r.version ?? 0)));
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up };
}

// ---------------------------------------------------------------------
// CUSTOMERS
//
// Omitted from v1 by mistake, which mattered more than it looked: without
// this, customer_entity_map has nothing to map, and the entire
// company-allocation dimension — "which company consumed this material" —
// cannot be answered at all. STFD and PJ&CJ hold accounts here.
//
// It also turns the top non-quoted buyers from UUIDs into names. 2,118
// sales have a customer and no quote, concentrated on a handful of ids —
// 577 on one alone. Those are either account customers pulling without a
// quote, or something else entirely. Names decide it.
// ---------------------------------------------------------------------
async function syncCustomers(runId: string, full: boolean) {
  const logId = await logStart(runId, "customers");
  let seen = 0, up = 0, maxV = await lastCursor("customers", full);
  try {
    for await (const rows of paginate("customers", maxV)) {
      seen += rows.length;
      const now = new Date().toISOString();
      const mapped = rows.map((c: any) => ({
        customer_id: c.id,
        customer_code: c.customer_code,
        first_name: c.first_name,
        last_name: c.last_name,
        company_name: c.company_name,
        email: c.email,
        deleted_at: c.deleted_at,
        ls_version: c.version ?? null,
        raw: c,
        synced_at: now,
        last_seen_at: now,
      }));
      const { error } = await db.from("ls_customers")
        .upsert(mapped, { onConflict: "customer_id" });
      if (error) throw new Error(error.message);
      up += mapped.length;
      maxV = Math.max(maxV, ...rows.map((r: any) => Number(r.version ?? 0)));
      await sleep(PAGE_PAUSE_MS);
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up };
}

// ---------------------------------------------------------------------
// PRODUCTS  (+ product_suppliers, + cost history diff)
//
// The cost diff is the whole reason this runs early. Lightspeed holds only
// the CURRENT supply_price; "what has gone up in cost?" is unanswerable
// without a before. We read the existing prices for this batch, upsert,
// then write history rows ONLY where the price actually moved.
// ---------------------------------------------------------------------
async function syncProducts(runId: string, full: boolean) {
  const logId = await logStart(runId, "products");
  let seen = 0, up = 0, costRows = 0;
  let maxV = await lastCursor("products", full);
  try {
    for await (const rows of paginate("products", maxV)) {
      seen += rows.length;
      const now = new Date().toISOString();

      // --- previous costs for this batch -----------------------------
      const ids = rows.map((p: any) => p.id);
      const { data: prev } = await db.from("ls_products")
        .select("product_id, supply_price").in("product_id", ids);
      const prevCost = new Map<string, number | null>(
        (prev ?? []).map((r: any) => [r.product_id, r.supply_price]),
      );

      // --- products ---------------------------------------------------
      const mapped = rows.map((p: any) => ({
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        variant_name: p.variant_name,
        handle: p.handle,
        description: p.description,
        supplier_code: p.supplier_code,
        supplier_id: p.supplier_id,
        brand_id: p.brand_id,
        product_type_id: p.product_type_id,
        product_type_name: p.type?.name ?? null,
        category_name: p.product_category?.name ?? null,
        category_path: p.product_category?.category_path ?? null,
        supply_price: p.supply_price,
        price_including_tax: p.price_including_tax,
        price_excluding_tax: p.price_excluding_tax,
        is_active: p.is_active ?? p.active ?? null,
        has_inventory: p.has_inventory,
        is_composite: p.is_composite,
        has_variants: p.has_variants,
        variant_parent_id: p.variant_parent_id,
        family_id: p.family_id,
        source: p.source,                       // USER | SYSTEM — kept, not filtered
        account_code: p.account_code,           // GL hook for Sage, unused today
        account_code_purchase: p.account_code_purchase,
        weight: p.weight,
        weight_unit: p.weight_unit,
        length: p.length,
        width: p.width,
        height: p.height,
        dimensions_unit: p.dimensions_unit,
        image_url: p.image_url,
        ls_created_at: p.created_at,
        ls_updated_at: p.updated_at,
        deleted_at: p.deleted_at,
        ls_version: p.version,
        raw: p,
        synced_at: now,
        last_seen_at: now,
      }));
      const { error } = await db.from("ls_products")
        .upsert(mapped, { onConflict: "product_id" });
      if (error) throw new Error(error.message);
      up += mapped.length;

      // --- cost history: only where the price actually moved ----------
      const hist: any[] = [];
      for (const p of rows) {
        const before = prevCost.get(p.id);
        const after = p.supply_price;
        const isNew = !prevCost.has(p.id);
        if (isNew || Number(before) !== Number(after)) {
          hist.push({
            product_id: p.id,
            supply_price: after,
            previous_supply_price: isNew ? null : before,
            delta: isNew ? null : Number(after) - Number(before),
            observed_at: now,
            source: "sync",
          });
        }
      }
      if (hist.length) {
        const { error: he } = await db.from("product_cost_history").insert(hist);
        if (he) throw new Error(he.message);
        costRows += hist.length;
      }

      // --- product_suppliers: products can have MANY suppliers --------
      const ps: any[] = [];
      for (const p of rows) {
        for (const s of (p.product_suppliers ?? [])) {
          if (!s?.id) continue;
          ps.push({
            product_supplier_id: s.id,
            product_id: p.id,
            supplier_id: s.supplier_id,
            supplier_name: s.supplier_name,
            code: s.code,
            price: s.price,
            raw: s,
            synced_at: now,
            last_seen_at: now,
          });
        }
      }
      if (ps.length) {
        const { error: pe } = await db.from("ls_product_suppliers")
          .upsert(ps, { onConflict: "product_supplier_id" });
        if (pe) throw new Error(pe.message);
      }

      maxV = Math.max(maxV, ...rows.map((r: any) => Number(r.version ?? 0)));
      await sleep(PAGE_PAUSE_MS);
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up, costRows };
}

// ---------------------------------------------------------------------
// INVENTORY  (+ movement history diff)
//
// This is the answer to Taylor's "a manual adjustment occurs often".
// Lightspeed reports the CURRENT quantity and nothing about how it got
// there. By snapshotting only on change we can later compute:
//     unexplained movement = delta - sales - receipts
// Since Taylor confirmed STFS never raises purchase orders in Lightspeed,
// the sign is informative on its own: unexplained POSITIVE ~ material
// received, NEGATIVE ~ pulled or shrink.
//
// Writing only on CHANGE is load-bearing, not tidiness. Snapshotting every
// product every run would be ~175M rows/year and would blow the disk
// inside a year. On change it is ~200k. Same information, 1000x the cost.
// ---------------------------------------------------------------------
async function syncInventory(runId: string, full: boolean) {
  const logId = await logStart(runId, "inventory");
  let seen = 0, up = 0, moveRows = 0;
  let maxV = await lastCursor("inventory", full);
  try {
    for await (const rows of paginate("inventory", maxV)) {
      seen += rows.length;
      const now = new Date().toISOString();

      // --- previous quantities for this batch -------------------------
      const pids = [...new Set(rows.map((i: any) => i.product_id))];
      const { data: prev } = await db.from("ls_inventory")
        .select("product_id, outlet_id, current_amount").in("product_id", pids);
      const key = (p: string, o: string) => `${p}|${o}`;
      const prevQty = new Map<string, number | null>(
        (prev ?? []).map((r: any) => [key(r.product_id, r.outlet_id), r.current_amount]),
      );

      const mapped = rows.map((i: any) => ({
        product_id: i.product_id,
        outlet_id: i.outlet_id,
        inventory_id: i.id,
        inventory_level: i.inventory_level,
        current_amount: i.current_amount,
        average_cost: i.average_cost,
        reorder_point: i.reorder_point,
        reorder_amount: i.reorder_amount,
        deleted_at: i.deleted_at,
        ls_version: i.version,
        raw: i,
        synced_at: now,
        last_seen_at: now,
      }));
      const { error } = await db.from("ls_inventory")
        .upsert(mapped, { onConflict: "product_id,outlet_id" });
      if (error) throw new Error(error.message);
      up += mapped.length;

      // --- movement history: only where quantity actually moved -------
      const hist: any[] = [];
      for (const i of rows) {
        const k = key(i.product_id, i.outlet_id);
        const before = prevQty.get(k);
        const after = i.current_amount;
        const isNew = !prevQty.has(k);
        if (isNew || Number(before) !== Number(after)) {
          hist.push({
            product_id: i.product_id,
            outlet_id: i.outlet_id,
            current_amount: after,
            previous_amount: isNew ? null : before,
            delta: isNew ? null : Number(after) - Number(before),
            observed_at: now,
          });
        }
      }
      if (hist.length) {
        const { error: he } = await db.from("inventory_history").insert(hist);
        if (he) throw new Error(he.message);
        moveRows += hist.length;
      }

      maxV = Math.max(maxV, ...rows.map((r: any) => Number(r.version ?? 0)));
      await sleep(PAGE_PAUSE_MS);
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up, moveRows };
}

// ---------------------------------------------------------------------
// Entry point
//
// Entities run in dependency order but each logs independently, so one
// failure does not lose the work the others already did — the directive's
// "prevent one failed item from stopping the full sync", applied at the
// entity level.
// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  // Shared-secret gate: only pg_cron (header read from Vault) may trigger a sync.
  {
    const expected = Deno.env.get("SYNC_SECRET") ?? "";
    const got = req.headers.get("x-sync-secret") ?? "";
    let ok = expected.length >= 32 && got.length === expected.length;
    if (ok) { let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i); ok = diff === 0; }
    if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const started = Date.now();
  const runId = crypto.randomUUID();
  let full = false;
  try {
    const body = await req.json();
    full = body?.full === true;
  } catch { /* no body = incremental */ }

  const result: Record<string, unknown> = { run_id: runId, mode: full ? "full" : "incremental" };
  const errors: string[] = [];

  for (const [name, fn] of [
    ["outlets", syncOutlets],
    ["suppliers", syncSuppliers],
    ["customers", syncCustomers],
    ["products", syncProducts],
    ["inventory", syncInventory],
  ] as const) {
    try {
      result[name] = await fn(runId, full);
    } catch (e) {
      errors.push(`${name}: ${e}`);
      result[name] = { error: String(e) };
    }
  }

  result.errors = errors;
  result.elapsed_ms = Date.now() - started;

  return new Response(JSON.stringify(result, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: errors.length ? 207 : 200,
  });
});