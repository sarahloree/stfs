# STFS security follow-ups (not applied)

## Views (v_dead_stock and the reorder views): why they are not switched to security_invoker
The reorder engine (`index.html`) reads `v_reorder_run_latest`, `v_reorder_priority`,
`v_reorder_exceptions_latest`, `v_reorder_by_supplier` and `v_dead_stock` in the browser with the
**publishable (anon) key**. Those views run as their owner today, which is the only reason anon gets rows:
anon has **no** RLS policies on `reorder_*`, `ls_*`, or `supplier_*` tables (only authenticated,
forge_readonly and cerney_readonly do). Switching to `security_invoker = true` now would blank the dashboard.

Today, anyone with the publishable key (it's in this public repo) can read those five views.

**Proposed path:**
1. Put the reorder engine behind STFD sign-in (same pattern as Ask Lightspeed) and read the views through a
   Netlify function (`/.netlify/functions/reorder`) that verifies the STFD token and queries STFS with the
   service-role key server-side. STFD tokens are signed by a different project, so they can't be sent straight to STFS.
2. Then: `alter view public.<v> set (security_invoker = true);` for all seven views and
   `revoke select on public.<v> from anon, authenticated;`.
3. Optional in the same step: revoke EXECUTE from anon/authenticated on `fn_reorder_run`, `fn_reorder_refresh`,
   `fn_reorder_compute`, `fn_reorder_classify`, `fn_apply_order_rules` (pg_cron runs `fn_reorder_refresh()` as postgres, so it isn't affected).

## sync-lightspeed and sync-lightspeed-txn edge functions
Both are deployed with `verify_jwt = false` and do not check a secret, so anyone with the URL can trigger a
full Lightspeed sync that writes with the service-role key.

**Current callers (pg_cron in STFS, checked 2026-10-13):**
| Job | Schedule | Calls |
|---|---|---|
| `sync-lightspeed-catalog` | `0 * * * *` (hourly :00) | `net.http_post` -> `/functions/v1/sync-lightspeed`, header `Authorization: Bearer <STFS legacy anon JWT>` |
| `sync-lightspeed-txn` | `5 * * * *` (hourly :05) | `net.http_post` -> `/functions/v1/sync-lightspeed-txn`, same anon JWT |
| `reorder-engine-refresh` | `15 * * * *` | `select fn_reorder_refresh();` (no HTTP, unaffected) |

Check for any other caller (manual curl, Make scenario, a dashboard "sync now" button) before enforcing.

**Fix, in order (callers first):**
1. Generate a random secret and store it: `supabase secrets set SYNC_SECRET=<random 64 hex>` and in Vault:
   `select vault.create_secret('<same value>', 'sync_secret');`
2. Update both cron jobs to send it (read it from Vault so it isn't in cron.job text):
   ```sql
   select cron.alter_job(
     job_id := (select jobid from cron.job where jobname = 'sync-lightspeed-catalog'),
     command := $$
       select net.http_post(
         url := 'https://zhgfzpztvmazueuxkipm.supabase.co/functions/v1/sync-lightspeed',
         headers := jsonb_build_object('Content-Type','application/json',
           'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')),
         body := '{}'::jsonb)
     $$);
   -- same for 'sync-lightspeed-txn' with /functions/v1/sync-lightspeed-txn
   ```
   (Keep any existing `body` payload the jobs send today; copy it from `cron.job.command`.)
3. Add this check at the top of each function's handler, then deploy:
   ```ts
   const SECRET = Deno.env.get("SYNC_SECRET") ?? "";
   if (!SECRET || req.headers.get("x-sync-secret") !== SECRET)
     return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401,
       headers: { "Content-Type": "application/json" } });
   ```
   Check `sync_log` / `net._http_response` after the next :00 and :05 runs.
4. Rollback: remove the check and redeploy; cron keeps working because the extra header is harmless.
