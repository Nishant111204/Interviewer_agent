-- Organizations
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- HR users
create table if not exists hr_users (
  id uuid primary key references auth.users,
  org_id uuid references organizations,
  name text,
  email text
);

-- Question banks
create table if not exists question_sets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations,
  name text not null,
  role text,
  questions jsonb not null,
  created_at timestamptz default now()
);

-- Interview sessions
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations,
  created_by uuid references hr_users,
  candidate_name text not null,
  candidate_email text not null,
  job_title text not null,
  question_set_id uuid references question_sets,
  token text unique not null,
  status text default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  suspicion_score integer default 0,
  face_descriptor float8[],
  recommendation text,
  overall_score numeric,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '48 hours')
);

-- Transcript turns
create table if not exists transcript_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  role text not null,
  text text not null,
  question_id text,
  score integer,
  ts timestamptz default now()
);

-- Proctoring flags
create table if not exists proctoring_flags (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  flag_type text not null,
  severity text default 'low',
  detail jsonb,
  ts timestamptz default now()
);

-- RLS: HR can read their org's sessions
alter table sessions enable row level security;
create policy "hr_read_sessions" on sessions
  for select using (auth.uid() in (
    select id from hr_users where org_id = sessions.org_id
  ));
