-- backend/supabase/migrations/003_rls_and_summary.sql

-- Add summary column (stores Gemini's end_interview summary text)
alter table sessions add column if not exists summary text;

-- RLS on transcript_turns
alter table transcript_turns enable row level security;
create policy "hr_read_turns" on transcript_turns
  for select using (
    session_id in (
      select id from sessions
      where org_id in (
        select org_id from hr_users where id = auth.uid()
      )
    )
  );

-- RLS on proctoring_flags
alter table proctoring_flags enable row level security;
create policy "hr_read_flags" on proctoring_flags
  for select using (
    session_id in (
      select id from sessions
      where org_id in (
        select org_id from hr_users where id = auth.uid()
      )
    )
  );

-- RLS on question_sets (org-scoped, or null org_id = global/seeded)
alter table question_sets enable row level security;
create policy "hr_read_question_sets" on question_sets
  for select using (
    org_id in (select org_id from hr_users where id = auth.uid())
    or org_id is null
  );
