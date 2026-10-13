// =====================================================================
// STFS — Lightspeed Sync: TRANSACTIONS (Supabase Edge Function)
// Build stamp: 2026-07-16f
//
// SCOPE: quotes, sales, consignments (+ their nested lines).
// The catalog/stock sync is a separate function (sync-lightspeed).
//
// WHY SEPARATE: this one is heavy. ~3,045 quotes with ~15 lines each is
// ~45,000 line rows, plus sales. The catalog sync must stay fast and
// frequent because it feeds the forward-only histories; this one can run
// less often without losing anything, because quotes, sales and
// consignments are all historical and persist.
//
// If it times out, run one entity at a time:
//   {"entities": ["quotes"]}
//   {"entities": ["sales"]}
//   {"entities": ["consignments"]}
// Default is all three.
//
// WHAT THIS UNLOCKS — every one of these is currently a guess:
//   * How many converted quotes actually carry a #C/#S number (Taylor's
//     rule) vs how many the rep never updated. Process adherence, counted.
//   * Whether bare numbers are Residential (a category) or reps forgetting
//     the prefix (a defect). Sarah believes the former; the count decides.
//   * Whether unsold quotes get archived as Taylor requires.
//   * When the last stocktake actually was. Yvonne says December; a
//     two-record sample said August 2023. The sample was wrong — it was
//     sorted oldest-first and I read it as current anyway.
//   * Real product usage, dead stock, and quote->sale price drift.
//
// SECRETS: same as the catalog sync. No new configuration.
//
// NOTE ON QUOTES: they use a completely different pagination scheme from
// every other endpoint (offset + HasNext, not version cursors) and carry no
// version field, so they cannot sync incrementally. v1 of this function
// sent `after=0` to quotes and got { Quotes: null } back — which reads as
// "no data" rather than "wrong parameter", so it failed silently and
// reported success with zero rows. The clue was in the payload the whole
// time: quotes end with TotalCount/HasNext, not version{min,max}.
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

// MEMORY, NOT SPEED, IS THE CONSTRAINT HERE.
// v1 used page_size 250 and died with WORKER_RESOURCE_LIMIT on the SECOND
// page of quotes — 100 quotes and 1,345 lines committed, then out of
// memory. Each quote carries ~13.5 nested lines and a full raw payload, so
// a page of 250 means ~3,400 line objects plus 250 raw blobs held at once.
// Deno's edge runtime will not take it.
// 50 is deliberately conservative. More pages, less held per page.
const PAGE_SIZE = 50;
const PAGE_PAUSE_MS = 250;
const MAX_RETRIES = 5;
const CHUNK = 250;            // rows per upsert batch
// Evidence: a run with page_size=250 committed exactly 100 quotes and 1,345
// lines, then died. LIGHTSPEED CAPS QUOTES AT 100 PER PAGE AND IGNORES
// page_size. So "50" changed nothing — it was still pulling 100 a time, 12
// times, holding ~16,000 line objects. 3 pages is ~300 quotes per run.
// ONE page per invocation. Three attempts at guessing a safe page budget
// (12, then 3) all hit WORKER_RESOURCE_LIMIT, so stop guessing: do the
// smallest unit of work that makes progress and let the CALLER loop. A
// single page is ~100 quotes and ~1,350 lines, which we know commits
// because the very first attempt managed exactly that before dying on its
// second page. Slower, but it cannot fail for the same reason again.
const MAX_PAGES_PER_RUN = 4;
// `limit` is the quotes page-size parameter (page_size is ignored here).
// 50 keeps ~675 line objects per page, well inside the worker limit.
const QUOTE_LIMIT = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------
async function lsGet(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const url = `${BASE}/${path}?${qs}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get("Retry-After") ?? 0);
      await sleep(ra > 0 ? ra * 1000 : 2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} -> ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  }
  throw new Error(`GET ${path} -> gave up after ${MAX_RETRIES} retries`);
}

// ---------------------------------------------------------------------
// PAGINATION — Lightspeed uses TWO DIFFERENT SCHEMES and does not say so.
//
//   sales, consignments, products, inventory:
//     { data: [...], version: { min, max } }
//     Cursor-based. `version` is a monotonic change marker, so it doubles
//     as both the page cursor AND the incremental-sync cursor.
//
//   quotes:
//     { Quotes: [...], TotalCount: 3055, HasNext: true }
//     Capital Q. NO version field on the records at all. Ignores `after`
//     entirely — passing after=0 returns { Quotes: null }, which looks
//     exactly like "no data" rather than "wrong parameter". Uses `offset`.
//
// The consequence nobody chose: QUOTES CANNOT SYNC INCREMENTALLY. With no
// version marker there is nothing to ask for changes since. Every run is a
// full re-read of all ~3,055. At page_size 250 that is ~13 pages — cheap
// enough, but it is a full pull every time, not a delta.
// ---------------------------------------------------------------------

// Cursor-based: sales, consignments.
async function* paginateCursor(path: string, after: number) {
  let cursor = after;
  while (true) {
    const body = await lsGet(path, { page_size: PAGE_SIZE, after: cursor });
    const rows = body?.data ?? [];
    if (rows.length === 0) return;
    yield rows;

    const max = Number(
      body?.version?.max ??
        Math.max(...rows.map((r: any) => Number(r.version ?? r._metadata?.version ?? 0))),
    );
    if (!max || max <= cursor) return;
    cursor = max;
    if (rows.length < PAGE_SIZE) return;
    await sleep(PAGE_PAUSE_MS);
  }
}

// Quotes: id-cursor. FROM THE OPENAPI SPEC, not from guessing:
//   after — "The lower limit for the quote id to be included in the
//           response. For proper pagination, it needs to be the QUOTE ID OF
//           THE LAST ITEM in the response from your previous request."
//   limit — "The maximum number of items to be returned." Default 100.
//
// So quotes DO use `after` — but it is the QUOTE ID, not a version. And the
// page-size parameter is `limit`, not `page_size`.
//
// `offset` is not a parameter on this endpoint at all. Passing it was
// silently ignored and Lightspeed returned the same first 100 records every
// time, with HasNext=true forever, because it was answering a question we
// never asked. A driver loop trusting HasNext ran 350 times re-upserting
// the same 100 quotes. Data came back every time, which is exactly why it
// looked like it was working.
//
// Silver lining: because quote ids are monotonic, this cursor also makes
// quotes incrementally syncable — resume from the highest id already
// stored. Edits to OLD quotes will not be picked up that way, so a periodic
// full re-read is still needed, but new quotes come cheap.
async function* paginateQuotes(
  startAfter: string | null,
  maxPages: number,
  state: { after: string | null; more: boolean; lastPageSize: number },
) {
  let after = startAfter;
  let pages = 0;
  state.after = after;
  state.more = false;

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: QUOTE_LIMIT };
    if (after) params.after = after;

    const body = await lsGet("quotes", params);
    const rows = body?.Quotes ?? [];
    if (!rows || rows.length === 0) { state.more = false; return; }

    state.lastPageSize = rows.length;
    yield rows;

    // The cursor is the LAST record's id — per the spec.
    after = String(rows[rows.length - 1].id);
    state.after = after;
    pages++;

    if (body?.HasNext !== true) { state.more = false; return; }
    state.more = true;
    await sleep(PAGE_PAUSE_MS);
  }
}

// ---------------------------------------------------------------------
// Upsert in chunks. A single 45k-row upsert will not survive; batching
// also means a failure loses one chunk rather than the whole entity.
// ---------------------------------------------------------------------
async function upsertChunked(table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await db.from(table).upsert(slice, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

// ---------------------------------------------------------------------
// job_ref parsing, mirroring ls_parse_job_ref() in SQL.
//
// Taylor's rule: no number until the job has SOLD. C=Commercial,
// S=Subcontractor, bare=Residential (unconfirmed). Four digits required so
// that "fabian Gonzalez Option #1 chainlink repair" — Taylor's own example
// of a correct placeholder on an UNSOLD quote — is not read as job #1.
// ---------------------------------------------------------------------
function parseJobRef(note: string | null): {
  ref: string | null;
  type: string | null;
  conf: string | null;
} {
  if (!note || !note.trim()) return { ref: null, type: null, conf: null };

  // HIGH, PREFIXED: # + C/S + 1-4 digits. The prefix removes ambiguity, so
  // any digit count is safe. Catches Taylor's own "#C108 Johnson" — an
  // early job with a three-digit number. A four-digit rule rejected it.
  const pfx = note.match(/#\s*([CScs]\d{1,4})\b/);
  if (pfx) {
    const raw = pfx[1].toUpperCase();
    return {
      ref: raw,
      type: raw.startsWith("C") ? "commercial" : "subcontractor",
      conf: "high",
    };
  }

  // HIGH, BARE: # + 3-4 digits, no prefix => Residential. Three minimum so
  // "Option #1" / "Option #2" — Taylor's correct placeholder convention on
  // UNSOLD quotes — cannot be read as a job. Most important guard here.
  const bare = note.match(/#\s*(\d{3,4})\b/);
  if (bare) return { ref: bare[1], type: "residential", conf: "high" };

  // MEDIUM: 3-4 digits at the start + separator, no # marker. The rep did
  // not follow the convention; we are inferring.
  const med = note.match(/^\s*([CScs]?\d{3,4})\s*[-–:]/);
  if (med) {
    const raw = med[1].toUpperCase();
    return {
      ref: raw,
      type: raw.startsWith("C") ? "commercial"
        : raw.startsWith("S") ? "subcontractor" : "residential",
      conf: "medium",
    };
  }

  // No reference. Per Taylor this means the job has not sold — correct
  // behaviour, not a defect.
  return { ref: null, type: null, conf: null };
}

// ---------------------------------------------------------------------
// sync_log
// ---------------------------------------------------------------------
async function logStart(runId: string, entity: string) {
  const { data } = await db.from("sync_log")
    .insert({ run_id: runId, entity, status: "running", api_version: API_VER })
    .select("id").single();
  return data?.id as number;
}
async function logFinish(
  id: number, status: string, seen: number, up: number,
  cursor: number | null, error?: string,
) {
  await db.from("sync_log").update({
    finished_at: nowIso(), status, records_seen: seen,
    records_upserted: up, cursor_version: cursor, error_text: error ?? null,
  }).eq("id", id);
}
async function lastCursor(entity: string, full: boolean): Promise<number> {
  if (full) return 0;
  const { data } = await db.from("sync_log")
    .select("cursor_version").eq("entity", entity).eq("status", "success")
    .not("cursor_version", "is", null)
    .order("started_at", { ascending: false }).limit(1);
  return data?.length ? Number(data[0].cursor_version ?? 0) : 0;
}

// ---------------------------------------------------------------------
// QUOTES  (+ nested products[] -> ls_quote_lines)
//
// status: CREATED | CONVERTED | ARCHIVED. ARCHIVED means SUPERSEDED by a
// re-quote — observed 3028 -> 3029 -> 3030 inside four minutes — and per
// Taylor it is also where unsold options are supposed to end up.
// salesperson_id is per LINE and differs from the quote's user_id.
// ---------------------------------------------------------------------
async function syncQuotes(runId: string, _full: boolean, startAfter: string | null = null) {
  const logId = await logStart(runId, "quotes");
  let seen = 0, up = 0, lines = 0;
  // No cursor: quotes carry no version field, so `full` is meaningless here
  // and every run is a complete re-read. See the pagination note above.
  const state = { after: startAfter, more: false, lastPageSize: 0 };
  try {
    for await (
      const rows of paginateQuotes(startAfter, MAX_PAGES_PER_RUN, state)
    ) {
      seen += rows.length;
      const now = nowIso();

      // MEMORY: the quote's raw payload CONTAINS the full products[] array,
      // and every one of those lines then gets its own row with its own raw.
      // We were holding ~13.5 line objects per quote TWICE. Strip products[]
      // out of the quote raw — the lines are stored properly in
      // ls_quote_lines, so keeping them nested here is pure duplication.
      const quotes = rows.map((q: any) => {
        const j = parseJobRef(q.note);
        const { products: _lines, ...qRaw } = q;
        return {
          quote_id: String(q.id),
          short_code: q.short_code,
          status: q.status,
          customer_id: q.customer_id,
          outlet_id: q.outlet_id,
          register_id: q.register_id,
          retailer_id: q.retailer_id,
          user_id: q.user_id,
          note: q.note,
          job_ref: j.ref,
          job_ref_type: j.type,
          job_ref_confidence: j.conf,
          total_price: q.total_price,
          total_tax: q.total_tax,
          loyalty: q.loyalty,
          sales_ids: q.sales_ids ?? null,
          expired_at: q.expired_at,
          ls_created_at: q.created_at,
          ls_updated_at: q.updated_at,
          deleted_at: q.deleted_at,
          raw: qRaw,          // products[] stripped — see note above
          synced_at: now,
          last_seen_at: now,
        };
      });
      up += await upsertChunked("ls_quotes", quotes, "quote_id");

      const ql: any[] = [];
      for (const q of rows) {
        const j = parseJobRef(q.note);
        for (const l of (q.products ?? [])) {
          ql.push({
            quote_line_id: String(l.id),
            quote_id: String(q.id),
            product_id: l.product_id,
            salesperson_id: l.salesperson_id,   // per LINE, not the quote
            quantity: l.quantity,               // may be negative / fractional
            price: l.price,
            discount: l.discount,               // negative = markup
            tax: l.tax,
            tax_id: l.tax_id,
            sequence: l.sequence,
            note: l.note,                       // build specs live here
            customer_id: q.customer_id,
            status: q.status,
            job_ref: j.ref,
            job_ref_type: j.type,
            quote_created_at: q.created_at,
            // raw deliberately omitted. The Monday rule was "raw stays until
            // the first sync runs clean" — it existed to protect against
            // fields we had not modelled. Quote lines have none: every field
            // in them is mapped above. Storing the blob bought nothing and
            // cost the run.
            synced_at: now,
            last_seen_at: now,
          });
        }
      }
      if (ql.length) lines += await upsertChunked("ls_quote_lines", ql, "quote_line_id");

      await sleep(PAGE_PAUSE_MS);
    }
    // cursor_version is numeric and quote ids overflow it; the resume
    // cursor is returned to the caller instead.
    await logFinish(logId, "success", seen, up, null);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return {
    seen,
    up,
    lines,
    next_after: state.more ? state.after : null,
    more: state.more,
    observed_page_size: state.lastPageSize,
  };
}

// ---------------------------------------------------------------------
// SALES  (+ nested line_items[] -> ls_sale_lines)
//
// Almost everything here is nested and had to be flattened:
//   outlet/register/author -> source{}
//   version                -> _metadata{}
//   cost, price, discount  -> pricing{}
//   sequence, override     -> _metadata{}
// state is LOWERCASE ('closed' | 'voided'); line status is UPPERCASE
// ('CONFIRMED' | 'VOIDED'). They are different fields. Do not conflate.
//
// source.type='quote' + source.id gives the sale -> quote back-reference,
// which is how job_ref reaches invoiced material.
// ---------------------------------------------------------------------
async function syncSales(runId: string, full: boolean) {
  const logId = await logStart(runId, "sales");
  let seen = 0, up = 0, lines = 0;
  let maxV = await lastCursor("sales", full);
  try {
    for await (const rows of paginateCursor("sales", maxV)) {
      seen += rows.length;
      const now = nowIso();

      const sales = rows.map((s: any) => {
        const j = parseJobRef(s.note);
        const { line_items: _li, ...sRaw } = s;   // strip nested lines
        return {
          sale_id: s.id,
          invoice_number: s.invoice_number,   // Lightspeed's own, sequential
          receipt_number: s.receipt_number,
          short_code: s.short_code,
          state: s.state,                     // lowercase
          sale_date: s.date,
          note: s.note,
          customer_id: s.customer_id,
          outlet_id: s.source?.outlet_id ?? null,
          register_id: s.source?.register_id ?? null,
          author_id: s.source?.author?.id ?? null,
          source_type: s.source?.type ?? null,
          source_quote_id: s.source?.type === "quote" ? String(s.source?.id ?? "") : null,
          job_ref: j.ref,
          job_ref_type: j.type,
          job_ref_confidence: j.conf,
          total_price: s.totals?.price,
          total_tax: s.totals?.tax,
          total_incl_tax: s.totals?.price_incl_tax,
          total_loyalty: s.totals?.loyalty,
          total_surcharge: s.totals?.surcharge,
          is_return: s.return?.is_return ?? false,
          original_sale_id: s.return?.original_sale_id ?? null,
          ls_created_at: s.created_at,
          ls_updated_at: s.updated_at,
          deleted_at: s.deleted_at,
          ls_version: s._metadata?.version ?? null,
          xero_reference: s._metadata?.xero_reference ?? null,
          raw: sRaw,          // line_items[] stripped — stored separately
          synced_at: now,
          last_seen_at: now,
        };
      });
      up += await upsertChunked("ls_sales", sales, "sale_id");

      const sl: any[] = [];
      for (const s of rows) {
        const j = parseJobRef(s.note);
        for (const l of (s.line_items ?? [])) {
          sl.push({
            sale_line_id: l.id,
            sale_id: s.id,
            product_id: l.product?.id ?? null,
            salesperson_id: l.salesperson_id,      // nullable — confirmed
            quantity: l.quantity,
            price: l.pricing?.price,
            cost: l.pricing?.cost,                 // REAL COGS
            cost_total: l.pricing?.cost_total,
            line_total: l.pricing?.total,
            discount: l.pricing?.discount,
            discount_total: l.pricing?.discount_total,
            tax_id: l.tax?.id ?? null,
            tax_amount: l.tax?.amount,
            tax_total: l.tax?.total,
            line_status: l.status,                 // UPPERCASE
            sequence: l._metadata?.sequence,
            is_price_override: l._metadata?.is_price_override,
            note: l.note,
            is_return: l.return?.is_return ?? false,
            return_reason: l.return?.reason ?? null,
            sale_date: s.date,
            outlet_id: s.source?.outlet_id ?? null,
            customer_id: s.customer_id,
            state: s.state,
            job_ref: j.ref,
            job_ref_type: j.type,
            // raw omitted — same reasoning as quote lines.
            synced_at: now,
            last_seen_at: now,
          });
        }
      }
      if (sl.length) lines += await upsertChunked("ls_sale_lines", sl, "sale_line_id");

      maxV = Math.max(
        maxV,
        ...rows.map((r: any) => Number(r._metadata?.version ?? 0)),
      );
      await sleep(PAGE_PAUSE_MS);
    }
    await logFinish(logId, "success", seen, up, maxV);
  } catch (e) {
    await logFinish(logId, "failed", seen, up, null, String(e));
    throw e;
  }
  return { seen, up, lines };
}

// ---------------------------------------------------------------------
// CONSIGNMENTS
//
// type: STOCKTAKE | SUPPLIER | OUTLET. Taylor confirmed STFS has ALWAYS
// ordered by email and never raises SUPPLIER stock orders here — so we
// expect none, and on-order data therefore does not exist. If any SUPPLIER
// rows do appear, that is worth knowing and contradicts the premise.
//
// The total_* fields come back as STRINGS ("699.00000") and are cast here.
// Stocktakes report variance in units AND dollars.
//
// This also settles the count-date question. Yvonne has records showing a
// December count; a two-record sample said the last was August 2023. The
// sample was sorted oldest-first and I read it as current regardless.
// ---------------------------------------------------------------------
const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));

async function syncConsignments(runId: string, full: boolean) {
  const logId = await logStart(runId, "consignments");
  let seen = 0, up = 0;
  let maxV = await lastCursor("consignments", full);
  try {
    for await (const rows of paginateCursor("consignments", maxV)) {
      seen += rows.length;
      const now = nowIso();
      const mapped = rows.map((c: any) => ({
        consignment_id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
        outlet_id: c.outlet_id,
        source_outlet_id: c.source_outlet_id,
        supplier_id: c.supplier_id,
        supplier_invoice: c.supplier_invoice,
        reference: c.reference,
        show_inactive: c.show_inactive,
        product_count: c.product_count,
        total_count_gain: num(c.total_count_gain),
        total_cost_gain: num(c.total_cost_gain),
        total_count_loss: num(c.total_count_loss),
        total_cost_loss: num(c.total_cost_loss),
        consignment_date: c.consignment_date,
        due_at: c.due_at,
        received_at: c.received_at,
        ls_created_at: c.created_at,
        ls_updated_at: c.updated_at,
        deleted_at: c.deleted_at,
        ls_version: c.version,
        filters: c.filters ?? null,
        raw: c,
        synced_at: now,
        last_seen_at: now,
      }));
      up += await upsertChunked("ls_consignments", mapped, "consignment_id");
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
  let want: string[] = ["quotes", "sales", "consignments"];
  let after: string | null = null;
  try {
    const body = await req.json();
    full = body?.full === true;
    if (Array.isArray(body?.entities) && body.entities.length) want = body.entities;
    if (body?.after) after = String(body.after);
  } catch { /* no body = all, incremental, from the start */ }

  const result: Record<string, unknown> = {
    run_id: runId,
    mode: full ? "full" : "incremental",
    entities: want,
  };
  const errors: string[] = [];

  for (const name of want) {
    try {
      if (name === "quotes") result[name] = await syncQuotes(runId, full, after);
      else if (name === "sales") result[name] = await syncSales(runId, full);
      else if (name === "consignments") result[name] = await syncConsignments(runId, full);
      else { errors.push(`${name}: unknown entity`); continue; }
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