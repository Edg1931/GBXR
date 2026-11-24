-- GBXR schema. Every row belongs to one signed-in user (auth.uid()).
-- Caregivers can read a senior's data only for the scopes the senior shared.
-- The backend uses the service role for background jobs; the app and the
-- caregiver dashboard use user JWTs, so RLS is the real access boundary.

create type care_scope as enum ('meds', 'meals', 'activity', 'stories', 'safety', 'mood', 'messages');

create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  timezone text not null default 'America/New_York',
  latitude double precision,
  longitude double precision,
  diet_notes text,
  kroger_location_id text,
  updated_at timestamptz not null default now()
);

create table care_shares (
  senior_id uuid not null references auth.users on delete cascade,
  caregiver_id uuid not null references auth.users on delete cascade,
  scopes care_scope[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (senior_id, caregiver_id),
  check (senior_id <> caregiver_id)
);

create function has_care_scope(senior uuid, s care_scope) returns boolean
language sql stable security definer set search_path = public as $$
  select senior = auth.uid() or exists (
    select 1 from care_shares
    where senior_id = senior and caregiver_id = auth.uid() and s = any(scopes)
  );
$$;

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  bot_id text not null,
  title text not null,
  details text not null default '',
  status text not null check (status in ('queued', 'running', 'done', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on tasks (user_id, created_at desc);

create table pantry_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  taken_at timestamptz not null default now(),
  items jsonb not null
);
create index on pantry_snapshots (user_id, taken_at desc);

create table shopping_lists (
  user_id uuid primary key references auth.users on delete cascade,
  items text[] not null default '{}'
);

create table price_watches (
  user_id uuid not null references auth.users on delete cascade,
  product text not null,
  last_promo numeric(10, 2),
  primary key (user_id, product)
);

create table medications (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  name text not null,
  looks text not null,
  dose text not null,
  times text[] not null,
  with_food boolean not null default false,
  window_minutes int not null default 60,
  primary key (user_id, id)
);

create table dose_logs (
  user_id uuid not null references auth.users on delete cascade,
  medication_id text not null,
  slot text not null,           -- local 'YYYY-MM-DDTHH:mm'
  taken_at timestamptz not null default now(),
  primary key (user_id, medication_id, slot)
);

create table sightings (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  object text not null,
  location text not null,
  seen_at timestamptz not null default now(),
  source text not null check (source in ('camera', 'told'))
);
create index on sightings (user_id, lower(object), seen_at desc);

create table care_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  at timestamptz not null default now(),
  scope care_scope not null,
  kind text not null,
  text text not null
);
create index on care_events (user_id, at desc);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  senior_id uuid not null references auth.users on delete cascade,
  scope care_scope not null,
  urgent boolean not null default false,
  text text not null,
  at timestamptz not null default now(),
  key text not null unique
);
create index on alerts (senior_id, at desc);

create table notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  bot_id text not null,
  text text not null,
  at timestamptz not null default now()
);

-- Exactly-once markers for background jobs (service role only; no policies).
create table claims (
  key text primary key,
  claimed_at timestamptz not null default now()
);

-- Row level security ---------------------------------------------------------

alter table profiles enable row level security;
alter table care_shares enable row level security;
alter table tasks enable row level security;
alter table pantry_snapshots enable row level security;
alter table shopping_lists enable row level security;
alter table price_watches enable row level security;
alter table medications enable row level security;
alter table dose_logs enable row level security;
alter table sightings enable row level security;
alter table care_events enable row level security;
alter table alerts enable row level security;
alter table notifications enable row level security;
alter table claims enable row level security;

-- Owner-only tables.
create policy own on tasks for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on pantry_snapshots for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on shopping_lists for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on price_watches for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on sightings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on notifications for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Profiles: owner writes; caregivers with any share can read the name/timezone.
create policy own on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy caregiver_read on profiles for select using (
  exists (select 1 from care_shares where senior_id = profiles.user_id and caregiver_id = auth.uid())
);

-- Shares: only the senior grants or revokes; the caregiver can see the grant.
create policy senior_manages on care_shares for all using (senior_id = auth.uid()) with check (senior_id = auth.uid());
create policy caregiver_sees on care_shares for select using (caregiver_id = auth.uid());

-- Care data: owner full access; caregivers read within shared scopes.
create policy own on medications for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy caregiver_read on medications for select using (has_care_scope(user_id, 'meds'));
create policy own on dose_logs for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy caregiver_read on dose_logs for select using (has_care_scope(user_id, 'meds'));
create policy own on care_events for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy caregiver_read on care_events for select using (has_care_scope(user_id, scope));
create policy senior_read on alerts for select using (senior_id = auth.uid());
create policy caregiver_read on alerts for select using (has_care_scope(senior_id, scope));
