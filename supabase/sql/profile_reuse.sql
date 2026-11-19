-- =====================================================================
-- Never enrich the same LinkedIn profile twice.
-- Before claim_linkedin_profiles hands profiles to the scraper, any pending profile that is
-- already enriched in ANOTHER network (same LinkedIn URL, enriched in the last 90 days) gets a
-- copy of that data and is marked completed, so it is never scraped again.
-- Safe to re-run.
-- =====================================================================

create or replace function public.reuse_enriched_profiles(p_dataset_id uuid, p_max_age interval default interval '90 days')
returns integer language plpgsql security definer set search_path = public as $$
declare v_copied int;
begin
  with want as (
    select id, lower(regexp_replace(linkedin_url, '/+$', '')) as k
    from public.li_profiles
    where dataset_id = p_dataset_id and enrichment_status = 'pending' and linkedin_url is not null
  ), src as (
    select distinct on (lower(regexp_replace(s.linkedin_url, '/+$', '')))
           lower(regexp_replace(s.linkedin_url, '/+$', '')) as k, s.*
    from public.li_profiles s
    where s.enrichment_status = 'completed'
      and s.dataset_id <> p_dataset_id
      and coalesce(s.enriched_at, s.updated_at) > now() - p_max_age
      and lower(regexp_replace(s.linkedin_url, '/+$', '')) in (select k from want)
    order by lower(regexp_replace(s.linkedin_url, '/+$', '')), coalesce(s.enriched_at, s.updated_at) desc
  )
  update public.li_profiles t
     set full_name = coalesce(src.full_name, t.full_name),
         public_identifier = coalesce(src.public_identifier, t.public_identifier),
         headline = src.headline,
         current_title = src.current_title,
         current_company = src.current_company,
         location = src.location,
         experience = src.experience,
         education = src.education,
         skills = src.skills,
         raw_profile = src.raw_profile,
         enrichment_status = 'completed',
         enrichment_error = null,
         enrichment_started_at = null,
         enriched_at = coalesce(src.enriched_at, now()),
         updated_at = now()
    from want, src
   where t.id = want.id and want.k = src.k;
  get diagnostics v_copied = row_count;
  return v_copied;
end $$;

revoke all on function public.reuse_enriched_profiles(uuid, interval) from public, anon, authenticated;
grant execute on function public.reuse_enriched_profiles(uuid, interval) to service_role;

-- Patch claim_linkedin_profiles: reuse first, then claim only what still needs scraping.
do $do$
declare d text; n text;
begin
  d := pg_get_functiondef('public.claim_linkedin_profiles'::regproc);
  if position('reuse_enriched_profiles' in d) > 0 then
    raise notice 'claim_linkedin_profiles already reuses enriched profiles';
    return;
  end if;
  n := regexp_replace(d, '(BEGIN\s+)(RETURN QUERY)', '\1PERFORM public.reuse_enriched_profiles(p_dataset_id);\n    \2', 'i');
  if n = d then raise exception 'claim_linkedin_profiles anchor not found - left unchanged'; end if;
  execute n;
end
$do$;
