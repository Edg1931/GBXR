-- Keep the RLS helper out of the public API (/rest/v1/rpc). Policies reference
-- it by OID, so they keep working after the move. (Flagged by the Supabase
-- security advisor: SECURITY DEFINER function executable by anon.)
create schema if not exists private;
alter function public.has_care_scope(uuid, public.care_scope) set schema private;
revoke all on function private.has_care_scope(uuid, public.care_scope) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.has_care_scope(uuid, public.care_scope) to authenticated;
alter function private.has_care_scope(uuid, public.care_scope) set search_path = public;
