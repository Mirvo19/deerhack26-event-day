-- deerhack live schema. paste the whole thing into supabase sql editor and run.

create extension if not exists "pgcrypto";

-- tables
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) >= 1 and char_length(text) <= 500),
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- just one row, id = 1. displays count down from ends_at.
create table if not exists public.timer_state (
  id int primary key,
  status text not null default 'idle' check (status in ('idle','running','paused','ended')),
  label text not null default 'Hacking Period',
  duration_seconds int not null default 3600 check (duration_seconds >= 1 and duration_seconds <= 86400),
  remaining_seconds int not null default 3600 check (remaining_seconds >= 0 and remaining_seconds <= 86400),
  ends_at timestamptz null,
  updated_at timestamptz not null default now()
);
insert into public.timer_state (id, status, label, duration_seconds, remaining_seconds, ends_at)
values (1, 'idle', 'Hacking Period', 3600, 3600, null)
on conflict (id) do nothing;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) >= 1 and char_length(name) <= 80),
  tagline text not null default '' check (char_length(tagline) <= 140),
  track text not null default '' check (char_length(track) <= 40),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- files live in the motifs storage bucket, rows just point at them
create table if not exists public.motifs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) >= 1 and char_length(name) <= 80),
  slug text not null check (char_length(slug) >= 1 and char_length(slug) <= 80),
  storage_path text not null,
  public_url text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- same deal, alert-sounds bucket
create table if not exists public.alert_sounds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) >= 1 and char_length(name) <= 80),
  storage_path text not null,
  public_url text not null,
  is_active boolean not null default false,
  file_size int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- keeps updated_at fresh on every edit
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_announcements_touch on public.announcements;
create trigger trg_announcements_touch before update on public.announcements
for each row execute function public.touch_updated_at();

drop trigger if exists trg_timer_touch on public.timer_state;
create trigger trg_timer_touch before update on public.timer_state
for each row execute function public.touch_updated_at();

drop trigger if exists trg_teams_touch on public.teams;
create trigger trg_teams_touch before update on public.teams
for each row execute function public.touch_updated_at();

drop trigger if exists trg_motifs_touch on public.motifs;
create trigger trg_motifs_touch before update on public.motifs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_sounds_touch on public.alert_sounds;
create trigger trg_sounds_touch before update on public.alert_sounds
for each row execute function public.touch_updated_at();

-- anon key can only read. writes go through flask with the service key.
alter table public.announcements enable row level security;
alter table public.timer_state enable row level security;
alter table public.teams enable row level security;
alter table public.motifs enable row level security;
alter table public.alert_sounds enable row level security;

drop policy if exists "anon select announcements" on public.announcements;
create policy "anon select announcements" on public.announcements
for select to anon using (true);

drop policy if exists "anon select timer" on public.timer_state;
create policy "anon select timer" on public.timer_state
for select to anon using (true);

drop policy if exists "anon select teams" on public.teams;
create policy "anon select teams" on public.teams
for select to anon using (true);

drop policy if exists "anon select motifs" on public.motifs;
create policy "anon select motifs" on public.motifs
for select to anon using (true);

drop policy if exists "anon select sounds" on public.alert_sounds;
create policy "anon select sounds" on public.alert_sounds
for select to anon using (true);

-- storage buckets, public reads, uploads only via flask
insert into storage.buckets (id, name, public)
values ('motifs', 'motifs', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('alert-sounds', 'alert-sounds', true)
on conflict (id) do nothing;

drop policy if exists "public read motifs" on storage.objects;
create policy "public read motifs" on storage.objects
for select to anon using (bucket_id in ('motifs', 'alert-sounds'));

-- turn on realtime for all five tables (safe to re-run)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'announcements') then
    alter publication supabase_realtime add table public.announcements;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'timer_state') then
    alter publication supabase_realtime add table public.timer_state;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'teams') then
    alter publication supabase_realtime add table public.teams;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'motifs') then
    alter publication supabase_realtime add table public.motifs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alert_sounds') then
    alter publication supabase_realtime add table public.alert_sounds;
  end if;
end $$;

-- sample stuff so the screen isnt empty. delete before the real event.
insert into public.announcements (text, is_current) values
  ('Welcome to DeerHack School Edition 2026 — head to Sagarmatha Hall for the opening ceremony.', true),
  ('Lunch is served at the cafeteria block. Please bring your badges.', false),
  ('Mentor rooms open in 15 minutes on the 2nd floor.', false);

insert into public.teams (name, tagline, track, sort_order) values
  ('YakByte Collective', 'AI attendance for rural schools', 'AI for Good', 1),
  ('MomoCoders', 'Nepali recipe finder app', 'Web', 2),
  ('Himalayan Ping', 'Offline mesh chat for treks', 'Hardware', 3),
  ('ChiyaScript', 'Learn-to-code games in Nepali', 'Education', 4),
  ('LoadShedding Labs', 'Low-power sensor kits', 'IoT', 5),
  ('DeerTrail', 'Campus navigation for newcomers', 'Mobile', 6);
