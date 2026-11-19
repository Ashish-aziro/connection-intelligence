-- =====================================================================
-- Verified company facts from LinkedIn company pages
--   * link_dataset_companies   : profile experience → company_entities + li_profile_company_links (free)
--   * claim_li_company_research: queue of LinkedIn company pages to scrape (current jobs first)
--   * li_company_facts         : verified facts for one profile (used by 05A finalize)
--   * finalize_search_run      : patched in place to attach "companies" to every result
-- LinkedIn-sourced companies are keyed 'li:<page id>' (never merged by name) and use their own
-- statuses (li_pending / li_processing / li_failed → completed) so the older name-based AI
-- researcher (which claims status 'pending') never touches them.
-- =====================================================================

create or replace function public.link_dataset_companies(p_dataset_id uuid, p_profile_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_companies int; v_links int;
begin
  create temp table _li_exp on commit drop as
  select p.id as pid, (x.ord - 1)::int as idx, x.e,
         lower(substring(x.e->>'companyLinkedinUrl' from 'linkedin\.com/company/([^/?#]+)')) as uni,
         coalesce(x.e->'endDate'->>'text', '') ilike 'present' as cur
  from public.li_profiles p,
       jsonb_array_elements(case when jsonb_typeof(p.experience) = 'array' then p.experience else '[]'::jsonb end)
         with ordinality as x(e, ord)
  where p.dataset_id = p_dataset_id
    and (p_profile_ids is null or p.id = any(p_profile_ids));

  insert into public.company_entities (canonical_name, normalized_name, linkedin_url, research_status)
  select distinct on (uni) coalesce(nullif(btrim(e->>'companyName'), ''), uni), 'li:' || uni,
         'https://www.linkedin.com/company/' || uni || '/', 'li_pending'
  from _li_exp where uni is not null and uni <> ''
  order by uni, cur desc
  on conflict (normalized_name) do nothing;
  get diagnostics v_companies = row_count;

  insert into public.li_profile_company_links
    (profile_id, company_id, relationship, title, experience_index, start_date, end_date, is_current)
  select x.pid, c.id, case when x.cur then 'current' else 'past' end, x.e->>'position', x.idx,
         x.e->'startDate'->>'text', x.e->'endDate'->>'text', x.cur
  from _li_exp x join public.company_entities c on c.normalized_name = 'li:' || x.uni
  where x.uni is not null and x.uni <> ''
  on conflict (profile_id, company_id, relationship, experience_index) do nothing;
  get diagnostics v_links = row_count;

  return jsonb_build_object('ok', true, 'companies_added', v_companies, 'links_added', v_links);
end $$;

-- Next LinkedIn company pages to scrape for a dataset (or for specific profiles), current jobs first.
create or replace function public.claim_li_company_research(
  p_dataset_id uuid, p_limit int default 10, p_profile_ids uuid[] default null)
returns table (id uuid, linkedin_url text, canonical_name text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with cand as (
    select c.id, bool_or(l.is_current) as any_current, count(*) as people
    from public.company_entities c
    join public.li_profile_company_links l on l.company_id = c.id
    join public.li_profiles p on p.id = l.profile_id
    where p.dataset_id = p_dataset_id
      and (p_profile_ids is null or p.id = any(p_profile_ids))
      and c.normalized_name like 'li:%'
      and (c.research_status = 'li_pending'
           or (c.research_status = 'li_processing' and c.research_started_at < now() - interval '15 minutes'))
      and coalesce(c.research_attempts, 0) < 3
    group by c.id
    order by bool_or(l.is_current) desc, count(*) desc
    limit least(greatest(p_limit, 1), 10)
  )
  update public.company_entities c
     set research_status = 'li_processing', research_started_at = now(),
         research_attempts = coalesce(c.research_attempts, 0) + 1, updated_at = now()
    from cand
   where c.id = cand.id
  returning c.id, c.linkedin_url, c.canonical_name;
end $$;

-- Progress numbers for the website.
create or replace function public.li_company_research_status(p_dataset_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'companies', count(distinct c.id),
    'researched', count(distinct c.id) filter (where c.research_status = 'completed'),
    'pending', count(distinct c.id) filter (where c.research_status in ('li_pending', 'li_processing')),
    'failed', count(distinct c.id) filter (where c.research_status = 'li_failed'),
    'current_companies', count(distinct c.id) filter (where l.is_current),
    'current_researched', count(distinct c.id) filter (where l.is_current and c.research_status = 'completed'))
  from public.li_profiles p
  join public.li_profile_company_links l on l.profile_id = p.id
  join public.company_entities c on c.id = l.company_id and c.normalized_name like 'li:%'
  where p.dataset_id = p_dataset_id;
$$;

-- Verified facts (only from the company's own LinkedIn page) for one person's jobs.
-- One entry per company (a person's current role there wins), current employers first, max 6.
create or replace function public.li_company_facts(p_profile_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t.f order by t.cur desc, t.idx), '[]'::jsonb)
  from (
    select d.f, d.cur, d.idx
    from (
      select distinct on (c.id)
        l.is_current as cur, l.experience_index as idx,
        jsonb_build_object(
          'name', c.canonical_name,
          'role', l.title,
          'current', l.is_current,
          'dates', nullif(concat_ws(' – ', l.start_date, l.end_date), ''),
          'description', left(c.description, 400),
          'industries', to_jsonb(c.industries),
          'size', c.employee_range,
          'website', c.website_domain,
          'source', 'LinkedIn company page',
          'source_url', c.linkedin_url) as f
      from public.li_profile_company_links l
      join public.company_entities c on c.id = l.company_id
      where l.profile_id = p_profile_id
        and c.normalized_name like 'li:%'
        and c.research_status = 'completed'
        and c.company_facts->>'source' = 'linkedin_company_page'
      order by c.id, l.is_current desc, l.experience_index
    ) d
    order by d.cur desc, d.idx
    limit 6
  ) t;
$$;
revoke all on function public.li_company_facts(uuid) from public, anon, authenticated;
grant execute on function public.li_company_facts(uuid) to service_role;

-- Patch the live finalize_search_run so every result item carries "companies".
do $do$
declare d text; n text;
begin
  d := pg_get_functiondef('public.finalize_search_run'::regproc);
  if position('li_company_facts' in d) > 0 then
    raise notice 'finalize_search_run already patched';
    return;
  end if;
  n := replace(d, $q$'card', r.card) as item$q$, $q$'card', r.card, 'companies', public.li_company_facts(r.profile_id)) as item$q$);
  if n = d then raise exception 'finalize_search_run anchor not found - left unchanged'; end if;
  execute n;
end
$do$;

-- Only the server (service role, used by the edge function and 05A) may call these.
revoke all on function public.link_dataset_companies(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.claim_li_company_research(uuid, int, uuid[]) from public, anon, authenticated;
revoke all on function public.li_company_research_status(uuid) from public, anon, authenticated;
revoke all on function public.li_company_facts(uuid) from public, anon, authenticated;
grant execute on function public.link_dataset_companies(uuid, uuid[]) to service_role;
grant execute on function public.claim_li_company_research(uuid, int, uuid[]) to service_role;
grant execute on function public.li_company_research_status(uuid) to service_role;
grant execute on function public.li_company_facts(uuid) to service_role;
