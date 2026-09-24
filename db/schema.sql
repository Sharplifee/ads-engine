-- Unnamed ads engine. Brand-agnostic: every row is scoped by profile_slug.
create table if not exists ads_profiles (
  slug text primary key,
  display_name text not null,
  ad_account_id text not null,
  business_model text not null,
  primary_result text not null,
  config jsonb not null default '{}'::jsonb,
  baselines jsonb not null default '{}'::jsonb,
  autonomy jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One row per entity per pull. This is the time machine everything else reads.
create table if not exists ads_snapshots (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  captured_at timestamptz not null default now(),
  level text not null,                    -- campaign | adset | ad
  entity_id text not null,
  parent_id text,
  name text,
  status text,
  spend numeric, impressions bigint, clicks bigint,
  ctr numeric, cpm numeric, frequency numeric,
  results numeric, cost_per_result numeric,
  landing_page_views bigint, link_clicks bigint,
  raw jsonb
);
create index if not exists ads_snapshots_lookup on ads_snapshots (profile_slug, entity_id, captured_at desc);

create table if not exists ads_alerts (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  raised_at timestamptz default now(),
  rule_id text not null,
  severity text not null,                 -- high | medium | low | good
  level text, entity_id text, entity_name text,
  message text not null,
  evidence jsonb,
  acknowledged_at timestamptz
);

-- Every proposed or executed change, with the evidence that justified it.
create table if not exists ads_actions (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  proposed_at timestamptz default now(),
  rule_id text,
  action_type text not null,              -- pause | budget_change | refresh | create | none
  level text, entity_id text, entity_name text,
  payload jsonb,
  state text not null default 'proposed', -- proposed | approved | executed | rejected | expired
  approved_by text, executed_at timestamptz,
  result jsonb
);

-- Self-updating playbook: claims extracted from transcripts and articles.
create table if not exists ads_playbook (
  id bigserial primary key,
  added_at timestamptz default now(),
  claim text not null,                    -- one specific, testable statement
  category text,                          -- setting | threshold | structure | creative | policy
  source_type text,                       -- youtube | podcast | article | docs
  source_url text, source_author text, source_date date,
  corroborations int default 1,
  status text default 'candidate',        -- candidate | adopted | tested_failed | retired
  tested_on text[],                       -- profile slugs it was tested against
  notes text
);

create table if not exists ads_competitor_ads (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  seen_at timestamptz default now(),
  advertiser text, ad_archive_id text,
  format text, hook_type text, angle text, offer text,
  first_seen date, days_running int,
  snapshot_url text, body text, raw jsonb
);

-- ---------------------------------------------------------------------------
-- Multi-client / multi-account / multi-channel
-- ---------------------------------------------------------------------------
create table if not exists ads_orgs (
  id text primary key,                    -- the paying customer or agency
  display_name text not null,
  plan text default 'standard',
  created_at timestamptz default now()
);

alter table ads_profiles add column if not exists org_id text references ads_orgs(id) on delete cascade;
alter table ads_profiles add column if not exists channel text not null default 'meta';
alter table ads_profiles add column if not exists state text not null default 'observe';
  -- observe -> advise -> act : the trust ladder, per account, never global

-- What the engine proposes as a whole plan, not just one edit.
create table if not exists ads_plans (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  created_at timestamptz default now(),
  horizon text,                            -- day | week | launch
  situation text,                          -- what the engine believes is happening
  constraint_found text,                   -- the single biggest limiter right now
  moves jsonb,                             -- ordered list of proposed actions
  expected_effect jsonb,
  evidence jsonb,                          -- alerts, snapshots and playbook rows behind it
  state text default 'proposed'            -- proposed | approved | running | done | rejected
);

create table if not exists ads_creative_briefs (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  created_at timestamptz default now(),
  source text,                             -- winner | competitor_gap | playbook
  source_ref text,
  angle text, hook text, format text, medium text,
  audience text, geo text, offer text,
  copy jsonb,                              -- headline / primary text / description variants
  asset_spec text,                         -- what to shoot or design
  naming text,                             -- resolved from the profile convention
  state text default 'draft'               -- draft | approved | built | live | retired
);

create table if not exists ads_audit (
  id bigserial primary key,
  at timestamptz default now(),
  profile_slug text, actor text,           -- engine | user email
  what text, before_state jsonb, after_state jsonb, reason text
);


-- ---------------------------------------------------------------------------
-- Discovery, market index, outcomes and cold start (applied 2026-09-23)
-- ---------------------------------------------------------------------------
create table if not exists ads_media (
  id bigserial primary key,
  discovered_at timestamptz default now(),
  kind text not null, external_id text not null,
  title text, author text, url text, published_at timestamptz,
  found_via text, segment text, vertical text,
  transcript text, words int, processed_at timestamptz, claims_found int
);
create unique index if not exists ads_media_key on ads_media (kind, external_id);
create index if not exists ads_media_unprocessed on ads_media (processed_at) where processed_at is null;

create table if not exists ads_market_signals (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  captured_at timestamptz default now(),
  kind text not null, for_date date not null, place text, value jsonb
);
create unique index if not exists ads_market_signals_key on ads_market_signals (profile_slug, kind, for_date);

create table if not exists ads_market_index (
  id bigserial primary key,
  built_at timestamptz default now(), for_date date not null,
  segment text not null, format text not null, window_days int,
  survival jsonb, performance jsonb, reported jsonb, confidence text
);
create unique index if not exists ads_market_index_key on ads_market_index (segment, format, for_date);

create table if not exists ads_outcomes (
  id bigserial primary key,
  profile_slug text references ads_profiles(slug) on delete cascade,
  pulled_at timestamptz default now(), external_id text not null,
  created_at timestamptz, stage text, won boolean, value numeric,
  entity_id text, raw jsonb
);
create unique index if not exists ads_outcomes_key on ads_outcomes (profile_slug, external_id);
create index if not exists ads_outcomes_entity on ads_outcomes (profile_slug, entity_id);

create unique index if not exists ads_competitor_ads_key on ads_competitor_ads (ad_archive_id);
alter table ads_competitor_ads add column if not exists segment text;
alter table ads_competitor_ads add column if not exists vertical text;
alter table ads_playbook add column if not exists segment text;
alter table ads_playbook add column if not exists vertical text;
alter table ads_profiles add column if not exists data_mode text not null default 'blended';
alter table ads_plans add column if not exists data_mode text;
alter table ads_plans add column if not exists numbers_borrowed boolean;
alter table ads_creative_briefs add column if not exists confidence text;

create or replace function ads_true_cost_per_win(p_slug text)
returns table (entity_id text, entity_name text, spend numeric, wins bigint, cost_per_win numeric)
language sql stable as $$
  with latest as (
    select distinct on (s.entity_id) s.entity_id, s.name, s.spend
    from ads_snapshots s where s.profile_slug = p_slug and s.level = 'ad'
    order by s.entity_id, s.captured_at desc
  ), won as (
    select o.entity_id, count(*)::bigint as wins from ads_outcomes o
    where o.profile_slug = p_slug and o.won is true group by o.entity_id
  )
  select l.entity_id, l.name, l.spend, coalesce(w.wins, 0),
         case when coalesce(w.wins, 0) > 0 then l.spend / w.wins end
  from latest l left join won w on w.entity_id = l.entity_id order by 5 nulls last;
$$;
