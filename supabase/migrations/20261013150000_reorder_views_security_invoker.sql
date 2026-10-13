-- STFS (zhgfzpztvmazueuxkipm). Applied 2026-10-13.
-- The reorder engine now reads these views through netlify/functions/reorder-data.js
-- with the service-role key, so anon/authenticated no longer need them.
-- forge_readonly / cerney_readonly keep SELECT and have RLS SELECT policies on every base table.
alter view public.v_reorder_run_latest        set (security_invoker = true);
alter view public.v_reorder_latest            set (security_invoker = true);
alter view public.v_reorder_priority          set (security_invoker = true);
alter view public.v_reorder_exceptions_latest set (security_invoker = true);
alter view public.v_reorder_by_supplier       set (security_invoker = true);
alter view public.v_reorder_ordered           set (security_invoker = true);
alter view public.v_dead_stock                set (security_invoker = true);

revoke all on public.v_reorder_run_latest, public.v_reorder_latest, public.v_reorder_priority,
              public.v_reorder_exceptions_latest, public.v_reorder_by_supplier,
              public.v_reorder_ordered, public.v_dead_stock
  from anon, authenticated;

grant select on public.v_reorder_run_latest, public.v_reorder_latest, public.v_reorder_priority,
                public.v_reorder_exceptions_latest, public.v_reorder_by_supplier,
                public.v_reorder_ordered, public.v_dead_stock
  to service_role;

-- Rollback: see /workspace/pr-drafts/stfs_views_rollback_2026-10-13.txt
-- alter view public.<v> reset (security_invoker);
-- grant select on public.<v> to anon, authenticated;
