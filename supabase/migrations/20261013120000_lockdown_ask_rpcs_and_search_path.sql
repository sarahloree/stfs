-- NOT APPLIED. Review, then run in the STFS project (zhgfzpztvmazueuxkipm).
-- 1) ask_* RPCs: only service_role (Ask Lightspeed's Netlify function) may execute.
--    Checked 2026-10-13: anon already lacks EXECUTE; authenticated still has it.
begin;

revoke execute on function public.ask_stock_on_hand(text)              from public, anon, authenticated;
revoke execute on function public.ask_reorder_list(text)               from public, anon, authenticated;
revoke execute on function public.ask_restock_cost()                   from public, anon, authenticated;
revoke execute on function public.ask_dead_stock()                     from public, anon, authenticated;
revoke execute on function public.ask_unreliable_counts()              from public, anon, authenticated;
revoke execute on function public.ask_top_sales(text, integer)         from public, anon, authenticated;
revoke execute on function public.ask_stfd_purchases(integer)          from public, anon, authenticated;
revoke execute on function public.ask_sales_trend(integer)             from public, anon, authenticated;
revoke execute on function public.ask_inventory_value()                from public, anon, authenticated;
revoke execute on function public.ask_supplier_spend(text, integer)    from public, anon, authenticated;
revoke execute on function public.ask_inventory_turn(text, integer)    from public, anon, authenticated;
revoke execute on function public.ask_customer_credit(text)            from public, anon, authenticated;

grant execute on function public.ask_stock_on_hand(text)              to service_role;
grant execute on function public.ask_reorder_list(text)               to service_role;
grant execute on function public.ask_restock_cost()                   to service_role;
grant execute on function public.ask_dead_stock()                     to service_role;
grant execute on function public.ask_unreliable_counts()              to service_role;
grant execute on function public.ask_top_sales(text, integer)         to service_role;
grant execute on function public.ask_stfd_purchases(integer)          to service_role;
grant execute on function public.ask_sales_trend(integer)             to service_role;
grant execute on function public.ask_inventory_value()                to service_role;
grant execute on function public.ask_supplier_spend(text, integer)    to service_role;
grant execute on function public.ask_inventory_turn(text, integer)    to service_role;
grant execute on function public.ask_customer_credit(text)            to service_role;

-- 2) Pin search_path (advisor: function_search_path_mutable).
alter function public.fn_reorder_run(text, text) set search_path = public, pg_temp;

-- 3) Views are NOT switched to security_invoker here: see docs/security-followups.md.
--    The reorder engine reads them with the anon/publishable key, and anon has no
--    RLS policies on the reorder or ls_* tables, so security_invoker would return
--    zero rows and blank every tab.

commit;

-- Rollback:
-- grant execute on function public.ask_<name>(<args>) to authenticated;   -- per function
-- alter function public.fn_reorder_run(text, text) reset search_path;
