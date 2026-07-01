# Rich Interview Context — Design Spec
**Date:** 2026-07-01  
**Status:** Approved  

---

## Overview

Enhance the HR interview scheduling flow to capture rich candidate and role context (JD, resume, experience, LinkedIn, job role, custom instructions), pass it all to Gemini Live, and replace the static question-script approach with a fully adaptive, competency-driven interview powered by the user's expert interviewer prompt.

---

## Problem

Currently every candidate for a given role gets the exact same pre-written questions in the same order. Gemini knows only the candidate's name and a verbatim question list. There is no JD, no resume, no experience calibration — the interview cannot adapt to who the candidate actually is.

---

## Goals

1. HR can supply JD, resume (PDF or text), experience level, LinkedIn URL, job role, and custom instructions when scheduling.
2. All context reaches Gemini Live as part of the system instruction.
3. Gemini conducts a fully adaptive, competency-driven interview grounded in the candidate's actual background.
4. DB question sets remain available as optional competency anchors (toggle on/off per session).
5. End-of-interview assessment is richer: per-competency ratings, verified strengths, gaps, notable signals.

---

## Non-Goals

- Resume parsing / ATS integration (HR inputs manually or uploads PDF).
- Persistent file storage beyond the 48h Gemini Files API window.
- Resume screening before scheduling (this is purely interview-time context).

---

## Section 1: Database Schema

New migration (`004_rich_context.sql`):

```sql
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

-- question_set_id becomes optional (null when use_question_set = false)
ALTER TABLE sessions
  ALTER COLUMN question_set_id DROP NOT NULL;
```

### Column semantics

| Column | Type | Notes |
|---|---|---|
| `job_role` | text | SDE / Data Analyst / Business Analyst / GenAI / UI/UX Designer / custom string |
| `experience_years` | text | "Fresher" / "1" / "2-3" / "3-5" / "5+" |
| `jd_text` | text | Pasted JD text, or pdf-parse fallback |
| `jd_file_uri` | text | Gemini Files API URI (48h expiry) — preferred over jd_text |
| `resume_text` | text | Pasted resume text, or pdf-parse fallback |
| `resume_file_uri` | text | Gemini Files API URI — preferred over resume_text |
| `linkedin_url` | text | Optional |
| `custom_instructions` | text | Optional freetext to Gemini |
| `use_question_set` | boolean | Default true; false = fully free-form interview |

`question_set_id` is nullable. When `use_question_set = false`, it may be null.

---

## Section 2: Backend API

### Dependencies to add

```
multer          — multipart/form-data parsing, in-memory storage
pdf-parse       — fallback text extraction from PDF buffers
@google/genai   — already present; uses Files API (ai.files.upload)
```

### `POST /api/sessions` — updated

Accepts `multipart/form-data` (was `application/json`).

**Required fields:**
- `candidate_name`, `candidate_email`, `job_title`
- `job_role`, `experience_years`

**Optional fields:**
- `question_set_id`, `use_question_set` (defaults true)
- `jd_text` | `jd_file` (one, both, or neither)
- `resume_text` | `resume_file` (one, both, or neither)
- `linkedin_url`, `custom_instructions`

**PDF handling logic (per document field):**

```
if file uploaded:
  try:
    uri = await ai.files.upload({ buffer, mimeType: 'application/pdf' })
    store file_uri on session
  catch:
    text = await pdfParse(buffer) → extract text
    store jd_text / resume_text on session
else if text provided:
  store text directly
```

### `supabaseService.createSession()` — updated signature

```ts
createSession(params: {
  org_id, created_by, candidate_name, candidate_email, job_title,
  job_role, experience_years,
  question_set_id?: string,
  use_question_set: boolean,
  jd_text?: string, jd_file_uri?: string,
  resume_text?: string, resume_file_uri?: string,
  linkedin_url?: string, custom_instructions?: string,
})
```

### `supabaseService.getSession()` — updated return

Returns all new columns so the WebSocket relay has full context at interview start:

```ts
{
  id, status, expires_at, candidate_name,
  question_set,           // null when use_question_set = false
  use_question_set,
  job_role, experience_years,
  jd_text, jd_file_uri,
  resume_text, resume_file_uri,
  linkedin_url, custom_instructions,
}
```

### `GET /api/question-sets` — unchanged

Returns `{ id, role }`. Client-side filtering by `job_role` handles the dropdown.

---

## Section 3: Gemini System Prompt

### System instruction parts (in `interviewRelay.ts`)

```ts
const parts: Part[] = [{ text: buildSystemPromptText(session) }]

if (session.jd_file_uri)
  parts.push({ fileData: { mimeType: 'application/pdf', fileUri: session.jd_file_uri } })
if (session.resume_file_uri)
  parts.push({ fileData: { mimeType: 'application/pdf', fileUri: session.resume_file_uri } })

config.systemInstruction = { parts }
```

### Experience years → level label mapping

| `experience_years` value | Label injected into prompt |
|---|---|
| Fresher | Junior (0–2y) |
| 1 | Junior (0–2y) |
| 2-3 | Mid (2–5y) |
| 3-5 | Mid (2–5y) |
| 5+ | Senior (5+y) |

### `buildSystemPromptText()` — full template

```
You are an expert technical interviewer for Wohlig Transformations conducting a live,
voice-style technical interview. You are professional, warm, and sharp.

## INPUTS PROVIDED
- Job Role: {job_role}
- Experience Level: {experience_label}  // mapped from experience_years using table above
- LinkedIn: {linkedin_url | "not provided"}
{if jd_file_uri}
- Job Description: see attached PDF
{else if jd_text}
- Job Description:
  {jd_text}
{/if}
{if resume_file_uri}
- Candidate Resume: see attached PDF
{else if resume_text}
- Candidate Resume:
  {resume_text}
{/if}
{if custom_instructions}
## ADDITIONAL INSTRUCTIONS FROM HR
{custom_instructions}
{/if}

{if use_question_set && question_set}
## SUGGESTED COMPETENCY AREAS (from HR question bank)
HR has pre-selected the following areas for this role. Use them as your
4–5 competency anchors. Generate questions adaptively — do not read verbatim:
{questions mapped to topic labels}
{/if}

## INTERVIEW DURATION
- Total: 20–30 min scaled to level.
  - Junior: ~20 min, 3–4 areas.
  - Mid: ~25 min, 4–5 areas.
  - Senior: ~30 min, 4–5 areas probed to greater depth.
- Track elapsed time. When ~5 min remain, begin wrapping up.

## CORE PRINCIPLE: CONVERSATION, NOT QUESTIONNAIRE
1. Silently analyse JD + resume + LinkedIn to identify 4–5 key competency areas.
2. Ask ONE question at a time. Then LISTEN.
3. Your next question is generated dynamically from the candidate's actual answer.

## ADAPTIVE FOLLOW-UP LOGIC
For each answer:
- Strong and complete → acknowledge briefly, move to next competency area.
- Vague or shallow → probe deeper on SAME topic: "why", "how would you handle X",
  "what happens if…", "walk me through the tradeoff". Keep probing until satisfied.
- Clearly struggling → one clarifying variant, then gracefully move on.
- Escalate difficulty when candidate handles a topic easily; de-escalate when struggling.

## GROUNDING IN THEIR BACKGROUND
- Reference actual projects, companies, or tech they listed.
- Cross-check listed skills with real questions; don't accept claims at face value.

## HANDLING CANDIDATE CROSS-QUESTIONS
- Answer clarifying questions directly.
- If they push back with sound reasoning, acknowledge it — it is a strong signal.

## TONE & CONDUCT
- One question per turn. Keep your turns concise.
- Never dump multiple questions at once.
- Brief acknowledgements ("Makes sense", "Good — and…") then the next probe.
- Never reveal ideal answers or hint at scoring.

## STRUCTURE
1. Warm 2-line intro: greet {candidate_name}, state ~20–30 min technical chat.
2. Optional opener: one question about a project from their resume.
3. Core: 4–5 competency areas via adaptive follow-up loop.
4. Wrap-up (~last 3–5 min): invite candidate questions, thank them, close.

## SCORING
Call score_competency() silently after assessing each competency area.
Call end_interview() after the wrap-up concludes.

SCORING RUBRIC (1–5):
1 — No meaningful understanding
2 — Surface knowledge only
3 — Solid working knowledge
4 — Strong, nuanced understanding
5 — Expert: detailed, insightful, demonstrates real-world mastery
```

### Tool signatures — updated

**`score_competency()`** (replaces `score_answer()`):
```ts
{
  area: string,       // competency area label, e.g. "React state management"
  score: number,      // 1–5
  notes: string,      // one-line grounded in what candidate actually said
}
```

**`end_interview()`** — expanded payload:
```ts
{
  recommendation: "Strong Hire" | "Hire" | "Lean No" | "No Hire",
  competency_ratings: Array<{ area: string, score: number, justification: string }>,
  verified_strengths: string[],
  gaps: string[],
  notable_signals: string,
  followup_areas: string,
  summary: string,    // 2–3 sentence overall summary
}
```

Both tool results are stored on the session row / transcript_turns. `recommendation` and `summary` already have columns. `competency_ratings`, `verified_strengths`, `gaps`, `notable_signals`, `followup_areas` are added in the same migration `004_rich_context.sql` (combined with the context columns above).

---

## Section 4: Frontend — Two-Step Wizard Modal

### Modal changes

- Width: `max-w-md` → `max-w-2xl`
- Step indicator: two dots at top right, filled based on current step
- Form state shape:

```ts
interface CreateForm {
  // Step 1
  candidate_name: string
  candidate_email: string
  job_title: string
  job_role: string          // dropdown value or custom string
  job_role_custom: string   // shown when job_role === 'custom'
  experience_years: string
  linkedin_url: string
  // Step 2
  jd_mode: 'text' | 'pdf'
  jd_text: string
  jd_file: File | null
  resume_mode: 'text' | 'pdf'
  resume_text: string
  resume_file: File | null
  use_question_set: boolean
  question_set_id: string
  custom_instructions: string
}
```

### Step 1 — Candidate Details

Fields (all required unless noted):
- Candidate Name (text)
- Candidate Email (email)
- Job Title (text)
- Job Role (select: SDE / Data Analyst / Business Analyst / GenAI / UI/UX Designer / Custom)
  - When "Custom" selected: text input replaces the dropdown value
- Experience Level (select: Fresher / 1 yr / 2–3 yrs / 3–5 yrs / 5+ yrs)
- LinkedIn Profile URL (text, optional)

CTA: Cancel | Next →

### Step 2 — Interview Context

Fields:
- **Job Description** — tab switcher: Paste Text | Upload PDF
  - Paste Text: textarea
  - Upload PDF: drag-and-drop zone; shows filename + size + X to clear
- **Candidate Resume** — same tab switcher pattern
- **Question Bank** section:
  - Toggle: "Use DB question set" (on/off, default on)
  - When ON: Question Set dropdown, filtered client-side by job_role
  - When OFF: dropdown hidden
- **Custom Instructions** (textarea, optional, placeholder: "Any extra guidance for the interviewer AI…")

CTA: ← Back | Create & Send Invite

### Submission

Builds `FormData` and POSTs to `POST /api/sessions` as `multipart/form-data`.
Text fields use `formData.append(key, value)`.
File fields use `formData.append('jd_file', file)` / `formData.append('resume_file', file)`.

---

## Data Flow — End to End

```
HR fills wizard (Step 1 → Step 2)
  → POST /api/sessions (multipart/form-data)
  → Backend: upload PDFs to Gemini Files API (→ file_uri) or extract text (fallback)
  → supabaseService.createSession() stores all fields
  → Email invite sent to candidate

Candidate opens /interview/<token>
  → GET /candidate/sessions/:token → { candidateName, role }
  → Completes selfie + clicks Begin

WS /interview/:token opens
  → getSession(token) → full session row including all context fields
  → buildSystemPromptText(session) → rich text prompt
  → systemInstruction parts = [text] + [jd fileData?] + [resume fileData?]
  → Gemini Live session starts
  → Trigger: "Hello, I am ready to begin."
  → Gemini greets candidate by name, begins adaptive interview

During interview:
  → score_competency() called silently after each competency area
  → end_interview() called after wrap-up → stored to sessions row

HR views session detail:
  → Richer report: per-competency ratings, verified strengths, gaps, signals
```

---

## Files to Create / Modify

| File | Change |
|---|---|
| `backend/supabase/migrations/004_rich_context.sql` | New migration |
| `backend/src/agents/interviewer.ts` | New prompt builder, updated tool signatures |
| `backend/src/routes/sessions.ts` | Multipart support, PDF→Gemini Files API, fallback |
| `backend/src/services/supabase.ts` | Updated createSession(), getSession() |
| `frontend/app/hr/page.tsx` | Two-step wizard modal, FormData submission |

---

## Open Questions / Risks

- **Gemini Live + fileData in systemInstruction**: Not heavily documented. Needs integration testing. Fallback to text is the safety net.
- **Gemini Files API quota**: Uploads count against quota. If high volume, monitor usage.
- **PDF file size limit**: Gemini Files API accepts up to 2 GB; practical limit for resumes/JDs is well under 10 MB. Enforce a 10 MB client-side limit.
- **`summary` column**: Already exists on `sessions`. The richer `end_interview()` payload still populates it as the 2–3 sentence overview.
