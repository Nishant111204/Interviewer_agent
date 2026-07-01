-- backend/supabase/migrations/004_rich_context.sql

ALTER TABLE sessions
  ADD COLUMN job_role             text,
  ADD COLUMN experience_years     text,
  ADD COLUMN jd_text              text,
  ADD COLUMN jd_file_uri          text,
  ADD COLUMN resume_text          text,
  ADD COLUMN resume_file_uri      text,
  ADD COLUMN linkedin_url         text,
  ADD COLUMN custom_instructions  text,
  ADD COLUMN use_question_set     boolean default true,
  ADD COLUMN competency_ratings   jsonb,
  ADD COLUMN verified_strengths   jsonb,
  ADD COLUMN gaps                 jsonb,
  ADD COLUMN notable_signals      text,
  ADD COLUMN followup_areas       text;

ALTER TABLE sessions
  ALTER COLUMN question_set_id DROP NOT NULL;
