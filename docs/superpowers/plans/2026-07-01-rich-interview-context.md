# Rich Interview Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JD, resume (PDF or text), experience level, LinkedIn, job role, and custom instructions to the HR scheduling form; pass all context to Gemini Live via an adaptive expert-interviewer system prompt; replace static question scoring with per-competency ratings.

**Architecture:** Six independent layers — migration, agent logic, DB service, HTTP route, WebSocket relay, frontend. Each task produces a self-contained, testable change. Tasks 2–5 are backend; Task 6 is frontend.

**Tech Stack:** Node.js/TypeScript (Express + `tsx`), Supabase (Postgres), `@google/genai` (Gemini Live + Files API), `multer` (multipart), `pdf-parse` (PDF fallback), Next.js/React (frontend).

## Global Constraints

- All new `sessions` columns are nullable — existing sessions must not break.
- `question_set_id` becomes nullable; remove any NOT NULL constraint.
- PDF size enforced at 10 MB on the frontend before upload.
- `score_answer` tool is replaced by `score_competency`; the old tool declaration is removed.
- `end_interview` payload is expanded; old two-field signature is gone.
- Gemini Files API URIs have a 48 h expiry — files are not re-uploaded after that.
- No Content-Type header is set by the frontend fetch when sending FormData (browser sets it with boundary automatically).
- Backend sessions route switches from `express.json()` to `multer` middleware — do NOT keep both on the same route.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/supabase/migrations/004_rich_context.sql` | Create | All new session columns |
| `backend/src/agents/interviewer.ts` | Modify | InterviewContext type, prompt builder, updated tools |
| `backend/src/services/supabase.ts` | Modify | createSession, getSession, saveScore, finalizeSession |
| `backend/src/routes/sessions.ts` | Modify | Multipart parsing, PDF→Files API, fallback |
| `backend/src/websocket/interviewRelay.ts` | Modify | Build fileData system instruction parts |
| `frontend/app/hr/page.tsx` | Modify | Two-step wizard modal, FormData submission |

---

## Task 1: DB Migration

**Files:**
- Create: `backend/supabase/migrations/004_rich_context.sql`

**Interfaces:**
- Produces: 15 new nullable columns on `sessions`; `question_set_id` made nullable

- [ ] **Step 1: Create the migration file**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Open the Supabase dashboard → SQL Editor → paste the file contents → Run.

Or if the Supabase CLI is configured locally:
```bash
cd backend
npx supabase db push
```

- [ ] **Step 3: Verify columns exist**

Run this in the SQL Editor:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
```

Expected: all 14 new columns appear, `question_set_id` shows `YES` in `is_nullable`.

- [ ] **Step 4: Commit**

```bash
git add backend/supabase/migrations/004_rich_context.sql
git commit -m "feat: migration 004 — add rich context columns to sessions"
```

---

## Task 2: Jest Setup + Updated `interviewer.ts`

**Files:**
- Modify: `backend/src/agents/interviewer.ts`
- Create: `backend/jest.config.js`
- Create: `backend/src/agents/__tests__/interviewer.test.ts`

**Interfaces:**
- Produces:
  - `InterviewContext` — type consumed by Tasks 3, 4, 5
  - `FinalizeResult` — type consumed by Tasks 3, 4
  - `buildSystemPromptText(ctx: InterviewContext): string`
  - `toExperienceLabel(years: string): string`
  - `interviewerTools` — updated array (score_competency + expanded end_interview)
  - `executeTool(name, args, sessionId, db): Promise<Record<string, unknown>>`

- [ ] **Step 1: Install test dependencies**

```bash
cd backend
npm install --save-dev jest ts-jest @types/jest
```

- [ ] **Step 2: Create Jest config**

```js
// backend/jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
}
```

- [ ] **Step 3: Add test script to package.json**

In `backend/package.json`, add to `"scripts"`:
```json
"test": "jest"
```

- [ ] **Step 4: Write failing tests**

```ts
// backend/src/agents/__tests__/interviewer.test.ts
import { toExperienceLabel, buildSystemPromptText, InterviewContext } from '../interviewer'

describe('toExperienceLabel', () => {
  it('maps Fresher to Junior label', () => {
    expect(toExperienceLabel('Fresher')).toBe('Junior (0–2y)')
  })
  it('maps 1 to Junior label', () => {
    expect(toExperienceLabel('1')).toBe('Junior (0–2y)')
  })
  it('maps 2-3 to Mid label', () => {
    expect(toExperienceLabel('2-3')).toBe('Mid (2–5y)')
  })
  it('maps 3-5 to Mid label', () => {
    expect(toExperienceLabel('3-5')).toBe('Mid (2–5y)')
  })
  it('maps 5+ to Senior label', () => {
    expect(toExperienceLabel('5+')).toBe('Senior (5+y)')
  })
})

describe('buildSystemPromptText', () => {
  const base: InterviewContext = {
    candidateName: 'Jane',
    jobRole: 'SDE',
    experienceYears: '2-3',
    useQuestionSet: false,
  }

  it('includes candidate name in intro', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).toContain('Jane')
  })

  it('includes experience label not raw value', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).toContain('Mid (2–5y)')
    expect(prompt).not.toContain('2-3')
  })

  it('includes jd_text inline when no file URI', () => {
    const ctx = { ...base, jdText: 'Build scalable APIs' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('Build scalable APIs')
  })

  it('references attached PDF when jd_file_uri present', () => {
    const ctx = { ...base, jdFileUri: 'files/abc123' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('see attached PDF')
    expect(prompt).not.toContain('files/abc123')
  })

  it('includes competency section when useQuestionSet true', () => {
    const ctx: InterviewContext = {
      ...base,
      useQuestionSet: true,
      questionSet: {
        id: 'qs-1',
        name: 'SDE',
        role: 'SDE',
        questions: [
          { id: 'q1', text: 'Explain closures in JS', weight: 1 },
        ],
      },
    }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('SUGGESTED COMPETENCY AREAS')
    expect(prompt).toContain('Explain closures')
  })

  it('omits competency section when useQuestionSet false', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).not.toContain('SUGGESTED COMPETENCY AREAS')
  })

  it('includes custom instructions when provided', () => {
    const ctx = { ...base, customInstructions: 'Focus on system design' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('Focus on system design')
  })
})
```

- [ ] **Step 5: Run tests — verify they fail**

```bash
cd backend && npx jest
```

Expected: FAIL — `toExperienceLabel` not found, `InterviewContext` not found.

- [ ] **Step 6: Replace `interviewer.ts` with the full updated file**

```ts
// backend/src/agents/interviewer.ts
import { Type, type FunctionDeclaration } from '@google/genai'

export interface Question {
  id: string
  text: string
  expected_answer?: string
  weight: number
}

export interface QuestionSet {
  id: string
  name: string
  role: string
  questions: Question[]
}

export interface InterviewContext {
  candidateName: string
  jobRole: string
  experienceYears: string
  jdText?: string
  jdFileUri?: string
  resumeText?: string
  resumeFileUri?: string
  linkedinUrl?: string
  customInstructions?: string
  useQuestionSet: boolean
  questionSet?: QuestionSet
}

export interface FinalizeResult {
  recommendation: string
  competency_ratings: Array<{ area: string; score: number; justification: string }>
  verified_strengths: string[]
  gaps: string[]
  notable_signals?: string
  followup_areas?: string
  summary: string
}

export function toExperienceLabel(years: string): string {
  if (years === 'Fresher' || years === '1') return 'Junior (0–2y)'
  if (years === '2-3' || years === '3-5') return 'Mid (2–5y)'
  return 'Senior (5+y)'
}

export function buildSystemPromptText(ctx: InterviewContext): string {
  const expLabel = toExperienceLabel(ctx.experienceYears)
  const linkedinLine = ctx.linkedinUrl ? `- LinkedIn: ${ctx.linkedinUrl}` : '- LinkedIn: not provided'

  const jdSection = ctx.jdFileUri
    ? '- Job Description: see attached PDF'
    : ctx.jdText
    ? `- Job Description:\n${ctx.jdText}`
    : ''

  const resumeSection = ctx.resumeFileUri
    ? '- Candidate Resume: see attached PDF'
    : ctx.resumeText
    ? `- Candidate Resume:\n${ctx.resumeText}`
    : ''

  const customSection = ctx.customInstructions
    ? `\n## ADDITIONAL INSTRUCTIONS FROM HR\n${ctx.customInstructions}\n`
    : ''

  const competencySection =
    ctx.useQuestionSet && ctx.questionSet
      ? `\n## SUGGESTED COMPETENCY AREAS (from HR question bank)\nHR has pre-selected the following areas for this role. Use them as your 4–5 competency anchors. Generate questions adaptively — do not read verbatim:\n${ctx.questionSet.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n`
      : ''

  return `You are an expert technical interviewer for Wohlig Transformations conducting a live, voice-style technical interview. You are professional, warm, and sharp. Your goal is to accurately assess the candidate's real technical depth — not to quiz them against a fixed script.

## INPUTS PROVIDED
- Job Role: ${ctx.jobRole}
- Experience Level: ${expLabel}
${linkedinLine}
${jdSection}
${resumeSection}
${customSection}${competencySection}
## INTERVIEW DURATION
- Total: 20–30 min scaled to level.
  - Junior: ~20 min, 3–4 areas.
  - Mid: ~25 min, 4–5 areas.
  - Senior: ~30 min, 4–5 areas probed to greater depth.
- Track elapsed time mentally. When ~5 min remain, begin wrapping up. Do not exceed 30 minutes.

## CORE PRINCIPLE: THIS IS A CONVERSATION, NOT A QUESTIONNAIRE
1. Before starting, silently analyse the JD + resume + LinkedIn to identify 4–5 key competency areas most relevant to the role.
2. Ask ONE question at a time. Then LISTEN.
3. Your next question is generated dynamically from the candidate's actual answer — dig into what they said, don't jump to an unrelated topic.

## ADAPTIVE FOLLOW-UP LOGIC
For each answer:
- Strong and complete → acknowledge briefly, move to next competency area.
- Vague or shallow → probe deeper on SAME topic: "why", "how would you handle X", "what happens if…", "walk me through the tradeoff". Keep probing until satisfied.
- Clearly struggling → one clarifying variant, then gracefully move on.
- Escalate difficulty when candidate handles a topic easily; de-escalate when struggling. Calibrate live to find the edge of their ability.

## GROUNDING IN THEIR BACKGROUND
- Pull specifics from the resume/LinkedIn. Reference actual projects, companies, or tech they listed.
- Cross-check claims: if they list a skill, verify it with a real question.

## HANDLING CANDIDATE CROSS-QUESTIONS
- Answer clarifying questions directly and helpfully.
- If they push back with sound reasoning, acknowledge it — a good candidate correcting you is a strong signal.
- Do not get defensive. Treat it as a real technical dialogue between peers.

## TONE & CONDUCT
- One question per turn. Keep your turns concise — you should talk less than the candidate.
- Never dump multiple questions at once.
- Brief acknowledgements ("Makes sense", "Good — and…") then the next probe.
- Never reveal ideal answers or hint at scoring.
- Stay in role. If asked something off-topic, redirect gently.

## STRUCTURE
1. Warm 2-line intro: greet ${ctx.candidateName}, state this is a ~20–30 min technical chat, invite them to think aloud and ask questions anytime.
2. Optional light opener: one question about a project from their resume to settle nerves.
3. Core: 4–5 competency areas, each explored via the adaptive follow-up loop.
4. Wrap-up (~last 3–5 min): invite the candidate's questions, thank them, close. Do not announce a verdict.

## SCORING
Call score_competency() silently after you have fully assessed each competency area.
Call end_interview() after the wrap-up concludes.

SCORING RUBRIC (1–5):
1 — No meaningful understanding
2 — Surface knowledge only
3 — Solid working knowledge
4 — Strong, nuanced understanding with practical knowledge
5 — Expert: detailed, insightful, demonstrates real-world mastery`.trim()
}

export const interviewerTools: FunctionDeclaration[] = [
  {
    name: 'score_competency',
    description: "Score the candidate's performance on a completed competency area",
    parameters: {
      type: Type.OBJECT,
      properties: {
        area: {
          type: Type.STRING,
          description: 'Competency area label, e.g. "React state management" or "System design"',
        },
        score: { type: Type.NUMBER, description: 'Score from 1 to 5' },
        notes: {
          type: Type.STRING,
          description: 'One-line evaluation grounded in what the candidate actually said',
        },
      },
      required: ['area', 'score', 'notes'],
    },
  },
  {
    name: 'end_interview',
    description: 'End the interview after wrap-up and provide structured assessment',
    parameters: {
      type: Type.OBJECT,
      properties: {
        recommendation: {
          type: Type.STRING,
          description: 'One of: "Strong Hire", "Hire", "Lean No", "No Hire"',
        },
        competency_ratings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              area: { type: Type.STRING },
              score: { type: Type.NUMBER },
              justification: { type: Type.STRING },
            },
          },
          description: 'Per-competency ratings with one-line justification grounded in what candidate said',
        },
        verified_strengths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Skills or claims the candidate confirmed under questioning',
        },
        gaps: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Weak areas or claims that did not hold up under probing',
        },
        notable_signals: {
          type: Type.STRING,
          description: 'Positive signals: good cross-questions, curiosity, communication quality',
        },
        followup_areas: {
          type: Type.STRING,
          description: 'Suggested areas for the next interview round',
        },
        summary: {
          type: Type.STRING,
          description: 'Two to three sentence overall summary of candidate performance',
        },
      },
      required: ['recommendation', 'competency_ratings', 'verified_strengths', 'gaps', 'summary'],
    },
  },
]

interface DB {
  saveScore(sessionId: string, area: string, score: number, notes: string): Promise<void>
  finalizeSession(sessionId: string, result: FinalizeResult): Promise<void>
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  db: DB,
): Promise<Record<string, unknown>> {
  if (name === 'score_competency') {
    await db.saveScore(
      sessionId,
      args['area'] as string,
      args['score'] as number,
      args['notes'] as string,
    )
    return { saved: true }
  }

  if (name === 'end_interview') {
    await db.finalizeSession(sessionId, {
      recommendation: args['recommendation'] as string,
      competency_ratings: args['competency_ratings'] as FinalizeResult['competency_ratings'],
      verified_strengths: args['verified_strengths'] as string[],
      gaps: args['gaps'] as string[],
      notable_signals: args['notable_signals'] as string | undefined,
      followup_areas: args['followup_areas'] as string | undefined,
      summary: args['summary'] as string,
    })
    return { ended: true }
  }

  return { error: `Unknown function: ${name}` }
}
```

- [ ] **Step 7: Run tests — verify they pass**

```bash
cd backend && npx jest
```

Expected: All 10 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/jest.config.js backend/src/agents/interviewer.ts backend/src/agents/__tests__/interviewer.test.ts backend/package.json
git commit -m "feat: adaptive interviewer prompt, score_competency tool, Jest setup"
```

---

## Task 3: Updated `supabase.ts`

**Files:**
- Modify: `backend/src/services/supabase.ts`

**Interfaces:**
- Consumes: `FinalizeResult` from `interviewer.ts` (Task 2)
- Produces:
  - `createSession(params)` — accepts all new context fields
  - `getSession(token)` — returns all new fields
  - `saveScore(sessionId, area, score, notes)` — stores competency score as transcript turn
  - `finalizeSession(sessionId, result: FinalizeResult)` — stores rich assessment

- [ ] **Step 1: Update `supabase.ts`**

Replace the entire file with:

```ts
// backend/src/services/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import type { QuestionSet, FinalizeResult } from '../agents/interviewer'

let _supabase: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    }
    _supabase = createClient(url, key, {
      realtime: { transport: require('ws') },
    })
  }
  return _supabase
}

const FLAG_SEVERITY: Record<string, 'low' | 'medium' | 'high'> = {
  tab_switch: 'medium',
  window_blur: 'low',
  face_absent: 'medium',
  face_multiple: 'high',
  gaze_away: 'low',
  copy_attempt: 'high',
  paste_attempt: 'high',
  fullscreen_exit: 'medium',
  right_click: 'low',
  keyboard_shortcut: 'low',
  impersonation: 'high',
}

export const supabaseService = {
  async getSession(token: string) {
    const { data, error } = await getClient()
      .from('sessions')
      .select('*, question_sets(*)')
      .eq('token', token)
      .single()
    if (error || !data) return null
    return {
      id: data.id as string,
      status: data.status as string,
      expires_at: data.expires_at as string,
      candidate_name: data.candidate_name as string,
      question_set: data.question_sets as unknown as QuestionSet | null,
      use_question_set: (data.use_question_set ?? true) as boolean,
      job_role: (data.job_role ?? '') as string,
      experience_years: (data.experience_years ?? 'Fresher') as string,
      jd_text: data.jd_text as string | null,
      jd_file_uri: data.jd_file_uri as string | null,
      resume_text: data.resume_text as string | null,
      resume_file_uri: data.resume_file_uri as string | null,
      linkedin_url: data.linkedin_url as string | null,
      custom_instructions: data.custom_instructions as string | null,
    }
  },

  async markSessionStarted(sessionId: string) {
    const { error } = await getClient()
      .from('sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', sessionId)
    if (error) console.error('[DB] markSessionStarted error:', error)
  },

  async saveScore(sessionId: string, area: string, score: number, notes: string) {
    const { error } = await getClient().from('transcript_turns').insert({
      session_id: sessionId,
      role: 'model',
      text: `[Competency: ${area} | Score: ${score}/5] ${notes}`,
      question_id: area,
      score,
    })
    if (error) console.error('[DB] saveScore error:', error)
  },

  async saveTranscriptTurn(sessionId: string, role: string, text: string) {
    const { error } = await getClient().from('transcript_turns').insert({ session_id: sessionId, role, text })
    if (error) console.error('[DB] saveTranscriptTurn error:', error)
  },

  async saveFlag(sessionId: string, flag: { type: string; ts: string; [k: string]: unknown }) {
    const { error } = await getClient().from('proctoring_flags').insert({
      session_id: sessionId,
      flag_type: flag.type,
      severity: FLAG_SEVERITY[flag.type] ?? 'low',
      detail: flag,
      ts: flag.ts,
    })
    if (error) console.error('[DB] saveFlag error:', error)
  },

  async finalizeSession(sessionId: string, result: FinalizeResult) {
    const { error } = await getClient()
      .from('sessions')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        recommendation: result.recommendation,
        summary: result.summary,
        competency_ratings: result.competency_ratings,
        verified_strengths: result.verified_strengths,
        gaps: result.gaps,
        notable_signals: result.notable_signals ?? null,
        followup_areas: result.followup_areas ?? null,
      })
      .eq('id', sessionId)
    if (error) console.error('[DB] finalizeSession error:', error)
  },

  async createSession(params: {
    org_id: string
    created_by: string
    candidate_name: string
    candidate_email: string
    job_title: string
    job_role: string
    experience_years: string
    question_set_id?: string
    use_question_set: boolean
    jd_text?: string
    jd_file_uri?: string
    resume_text?: string
    resume_file_uri?: string
    linkedin_url?: string
    custom_instructions?: string
  }) {
    const token = crypto.randomBytes(32).toString('hex')
    const { data, error } = await getClient()
      .from('sessions')
      .insert({ ...params, token })
      .select()
      .single()
    if (error) throw error
    return data as { id: string; token: string }
  },

  async listSessions(orgId: string) {
    const { data, error } = await getClient()
      .from('sessions')
      .select('id, candidate_name, candidate_email, job_title, status, suspicion_score, recommendation, overall_score, created_at, started_at, ended_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async getSessionDetail(sessionId: string, orgId: string) {
    const [{ data: session }, { data: turns }, { data: flags }] = await Promise.all([
      getClient().from('sessions').select('*').eq('id', sessionId).eq('org_id', orgId).single(),
      getClient().from('transcript_turns').select('*').eq('session_id', sessionId).order('ts'),
      getClient().from('proctoring_flags').select('*').eq('session_id', sessionId).order('ts'),
    ])
    return { session, turns: turns ?? [], flags: flags ?? [] }
  },

  async saveFaceDescriptor(token: string, descriptor: number[]): Promise<'ok' | 'not_found' | 'not_pending' | 'already_set' | 'error'> {
    const { data, error } = await getClient()
      .from('sessions')
      .select('id, status, face_descriptor')
      .eq('token', token)
      .single()

    if (error || !data) return 'not_found'
    if (data.status !== 'pending') return 'not_pending'
    if (data.face_descriptor !== null) return 'already_set'

    const { error: updateError } = await getClient()
      .from('sessions')
      .update({ face_descriptor: descriptor })
      .eq('id', data.id)

    if (updateError) {
      console.error('[DB] saveFaceDescriptor error:', updateError)
      return 'error'
    }
    return 'ok'
  },

  async getHrUser(userId: string): Promise<{ org_id: string } | null> {
    const { data, error } = await getClient()
      .from('hr_users')
      .select('org_id')
      .eq('id', userId)
      .single()
    if (error || !data) return null
    return { org_id: data.org_id as string }
  },

  async listQuestionSets(): Promise<Array<{ id: string; role: string }>> {
    const { data, error } = await getClient()
      .from('question_sets')
      .select('id, role')
    if (error) throw error
    return (data ?? []) as Array<{ id: string; role: string }>
  },

  async verifyToken(token: string): Promise<{ id: string } | null> {
    const { data: { user }, error } = await getClient().auth.getUser(token)
    if (error || !user) return null
    return { id: user.id }
  },
}

export { getClient as getSupabaseClient }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/supabase.ts
git commit -m "feat: update supabase service for rich context fields and FinalizeResult"
```

---

## Task 4: Updated Sessions Route (Multipart + PDF Handling)

**Files:**
- Modify: `backend/src/routes/sessions.ts`

**Interfaces:**
- Consumes: `supabaseService.createSession()` (Task 3)
- Produces: `POST /api/sessions` accepting `multipart/form-data` with all new fields

- [ ] **Step 1: Install dependencies**

```bash
cd backend
npm install multer pdf-parse
npm install --save-dev @types/multer @types/pdf-parse
```

- [ ] **Step 2: Replace `sessions.ts` with full updated file**

```ts
// backend/src/routes/sessions.ts
import { Router } from 'express'
import multer from 'multer'
import pdfParse from 'pdf-parse'
import { GoogleGenAI } from '@google/genai'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { supabaseService } from '../services/supabase'
import { emailService } from '../services/email'

const router = Router()
router.use(authMiddleware)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
})

async function uploadPdfToGemini(buffer: Buffer, filename: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set')
  const ai = new GoogleGenAI({ apiKey })
  const blob = new Blob([buffer], { type: 'application/pdf' })
  const file = await ai.files.upload({
    file: blob,
    config: { displayName: filename, mimeType: 'application/pdf' },
  })
  if (!file.uri) throw new Error('Files API returned no URI')
  return file.uri
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer)
  return data.text
}

async function resolveDocument(
  file: Express.Multer.File | undefined,
  text: string | undefined,
): Promise<{ text?: string; fileUri?: string }> {
  if (file) {
    try {
      const fileUri = await uploadPdfToGemini(file.buffer, file.originalname)
      return { fileUri }
    } catch (err) {
      console.warn('[sessions] Gemini Files API upload failed, falling back to pdf-parse:', err)
      const extracted = await extractPdfText(file.buffer)
      return { text: extracted }
    }
  }
  if (text) return { text }
  return {}
}

// POST /api/sessions — create session + send invite email
router.post(
  '/',
  upload.fields([
    { name: 'jd_file', maxCount: 1 },
    { name: 'resume_file', maxCount: 1 },
  ]),
  async (req: AuthRequest, res) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
    const body = req.body as Record<string, string>

    const { candidate_name, candidate_email, job_title, job_role, experience_years } = body
    if (!candidate_name || !candidate_email || !job_title || !job_role || !experience_years) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    const use_question_set = body.use_question_set !== 'false'
    const question_set_id = body.question_set_id || undefined

    if (use_question_set && !question_set_id) {
      res.status(400).json({ error: 'question_set_id required when use_question_set is true' })
      return
    }

    try {
      const [jdResult, resumeResult] = await Promise.all([
        resolveDocument(files?.['jd_file']?.[0], body.jd_text || undefined),
        resolveDocument(files?.['resume_file']?.[0], body.resume_text || undefined),
      ])

      const session = await supabaseService.createSession({
        org_id: req.orgId!,
        created_by: req.hrUserId!,
        candidate_name,
        candidate_email,
        job_title,
        job_role,
        experience_years,
        question_set_id,
        use_question_set,
        jd_text: jdResult.text,
        jd_file_uri: jdResult.fileUri,
        resume_text: resumeResult.text,
        resume_file_uri: resumeResult.fileUri,
        linkedin_url: body.linkedin_url || undefined,
        custom_instructions: body.custom_instructions || undefined,
      })

      await emailService.sendInvite({
        to: candidate_email,
        candidateName: candidate_name,
        jobTitle: job_title,
        token: session.token,
      })

      res.status(201).json({ id: session.id, token: session.token })
    } catch (err) {
      console.error('[POST /api/sessions]', err)
      res.status(500).json({ error: 'Failed to create session' })
    }
  },
)

// GET /api/sessions — list sessions for org
router.get('/', async (req: AuthRequest, res) => {
  try {
    const sessions = await supabaseService.listSessions(req.orgId!)
    res.json(sessions)
  } catch (err) {
    console.error('[GET /api/sessions]', err)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// GET /api/sessions/:id — full session detail
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const detail = await supabaseService.getSessionDetail(req.params.id, req.orgId!)
    if (!detail.session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    console.error('[GET /api/sessions/:id]', err)
    res.status(500).json({ error: 'Failed to get session' })
  }
})

export default router
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Run existing tests to confirm nothing broke**

```bash
cd backend && npx jest
```

Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/sessions.ts backend/package.json backend/package-lock.json
git commit -m "feat: sessions route — multipart, Gemini Files API PDF upload with pdf-parse fallback"
```

---

## Task 5: Updated WebSocket Relay

**Files:**
- Modify: `backend/src/websocket/interviewRelay.ts`

**Interfaces:**
- Consumes:
  - `buildSystemPromptText(ctx: InterviewContext)` from Task 2
  - `InterviewContext` from Task 2
  - `getSession()` return shape from Task 3
- Produces: Gemini Live session with multi-part system instruction (text + optional fileData parts)

- [ ] **Step 1: Replace `interviewRelay.ts` with full updated file**

```ts
// backend/src/websocket/interviewRelay.ts
import WebSocket from 'ws'
import {
  GoogleGenAI,
  Modality,
  FunctionResponse,
  type LiveServerMessage,
  type FunctionCall,
  type Session,
  type Part,
} from '@google/genai'
import {
  buildSystemPromptText,
  interviewerTools,
  executeTool,
  type InterviewContext,
} from '../agents/interviewer'
import { supabaseService } from '../services/supabase'
import { generateReport } from '../services/report'

interface ProctoringFlag {
  type: string
  ts: string
  [key: string]: unknown
}

interface BrowserMessage {
  type: 'audio' | 'video' | 'flag' | 'transcript'
  data?: string
  event?: ProctoringFlag
  text?: string
  role?: string
}

export async function handleInterviewSocket(ws: WebSocket, token: string) {
  const db = supabaseService

  const session = await db.getSession(token)
  if (!session) { ws.close(4001, 'Session not found'); return }
  if (session.status !== 'pending') { ws.close(4002, 'Session already completed or expired'); return }
  if (new Date(session.expires_at) <= new Date()) { ws.close(4003, 'Session link expired'); return }

  await db.markSessionStarted(session.id)
  console.log(`[WS] Interview started: session=${session.id}`)

  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.error('[WS] GOOGLE_API_KEY not set')
    ws.close(1011, 'Server misconfiguration')
    return
  }

  const ctx: InterviewContext = {
    candidateName: session.candidate_name,
    jobRole: session.job_role || 'the role',
    experienceYears: session.experience_years || 'Fresher',
    jdText: session.jd_text ?? undefined,
    jdFileUri: session.jd_file_uri ?? undefined,
    resumeText: session.resume_text ?? undefined,
    resumeFileUri: session.resume_file_uri ?? undefined,
    linkedinUrl: session.linkedin_url ?? undefined,
    customInstructions: session.custom_instructions ?? undefined,
    useQuestionSet: session.use_question_set,
    questionSet: session.use_question_set && session.question_set ? session.question_set : undefined,
  }

  const systemParts: Part[] = [{ text: buildSystemPromptText(ctx) }]
  if (ctx.jdFileUri) systemParts.push({ fileData: { mimeType: 'application/pdf', fileUri: ctx.jdFileUri } })
  if (ctx.resumeFileUri) systemParts.push({ fileData: { mimeType: 'application/pdf', fileUri: ctx.resumeFileUri } })

  const ai = new GoogleGenAI({ apiKey })
  let liveSession: Session | null = null
  let sessionClosed = false
  const pendingMessages: BrowserMessage[] = []

  const connectPromise = ai.live.connect({
    model: 'gemini-2.0-flash-exp',
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: systemParts },
      tools: [{ functionDeclarations: interviewerTools }],
    },
    callbacks: {
      onopen: () => {
        console.log('[WS] Gemini Live connected, session=', session.id)
      },
      onmessage: (msg: LiveServerMessage) => {
        handleGeminiMessage(msg, ws, session.id, db, liveSession).catch((err) =>
          console.error('[WS] Error handling Gemini message:', err),
        )
      },
      onerror: (e: { message?: string; error?: unknown }) => {
        console.error('[WS] Gemini Live error:', e.message ?? e)
      },
      onclose: (e: { code?: number; reason?: string }) => {
        console.log('[WS] Gemini Live closed:', e.code, e.reason)
        sessionClosed = true
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'AI session ended')
      },
    },
  })

  connectPromise
    .then((ls) => {
      liveSession = ls
      console.log('[WS] Sending initial greeting trigger, session=', session.id)
      try {
        ls.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'Hello, I am ready to begin.' }] }],
          turnComplete: true,
        })
      } catch (err) {
        console.error('[WS] Failed to send greeting trigger:', err)
      }

      for (const msg of pendingMessages) {
        dispatchToGemini(msg, liveSession!)
      }
      pendingMessages.length = 0
    })
    .catch((err) => {
      console.error('[WS] Failed to connect to Gemini Live:', err)
      ws.close(1011, 'Failed to start AI session')
    })

  ws.on('message', async (raw) => {
    let msg: BrowserMessage
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'flag') {
      if (msg.event) await db.saveFlag(session.id, msg.event)
      return
    }

    if (!liveSession) { pendingMessages.push(msg); return }
    dispatchToGemini(msg, liveSession)
  })

  ws.on('close', () => {
    console.log(`[WS] Browser disconnected: session=${session.id}`)
    if (!sessionClosed) liveSession?.close()
    generateReport(session.id).catch(err =>
      console.error('[Report] Failed to generate:', err),
    )
  })

  ws.on('error', (err) => {
    console.error('[WS] Browser socket error:', err)
    if (!sessionClosed) liveSession?.close()
  })
}

function dispatchToGemini(msg: BrowserMessage, liveSession: Session) {
  switch (msg.type) {
    case 'audio':
      if (msg.data) liveSession.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } })
      break
    case 'video':
      if (msg.data) liveSession.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } })
      break
  }
}

async function handleGeminiMessage(
  msg: LiveServerMessage,
  ws: WebSocket,
  sessionId: string,
  db: typeof supabaseService,
  liveSession: Session | null,
) {
  const content = msg.serverContent

  if (content?.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }))
      }
      if (part.text) {
        await db.saveTranscriptTurn(sessionId, 'model', part.text)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role: 'model', text: part.text }))
        }
      }
    }
  }

  if (content?.inputTranscription?.text) {
    const text = content.inputTranscription.text
    await db.saveTranscriptTurn(sessionId, 'user', text)
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'transcript', role: 'user', text }))
  }

  if (content?.outputTranscription?.text) {
    const text = content.outputTranscription.text
    await db.saveTranscriptTurn(sessionId, 'model', text)
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'transcript', role: 'model', text }))
  }

  if (msg.toolCall?.functionCalls && liveSession) {
    const responses = await runToolCalls(msg.toolCall.functionCalls, sessionId, db)
    if (responses.length > 0) liveSession.sendToolResponse({ functionResponses: responses })
  }
}

async function runToolCalls(
  calls: FunctionCall[],
  sessionId: string,
  db: typeof supabaseService,
): Promise<FunctionResponse[]> {
  const responses: FunctionResponse[] = []

  for (const call of calls) {
    const name = call.name ?? ''
    const args = (call.args ?? {}) as Record<string, unknown>
    let result: Record<string, unknown>

    try {
      result = await executeTool(name, args, sessionId, db)
    } catch (err) {
      console.error(`[WS] Error executing tool ${name}:`, err)
      result = { error: String(err) }
    }

    const fr = new FunctionResponse()
    fr.id = call.id ?? ''
    fr.name = name
    fr.response = result
    responses.push(fr)
  }

  return responses
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run tests**

```bash
cd backend && npx jest
```

Expected: All 10 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/websocket/interviewRelay.ts
git commit -m "feat: relay — multi-part system instruction with Gemini fileData for JD/resume PDFs"
```

---

## Task 6: Frontend Two-Step Wizard Modal

**Files:**
- Modify: `frontend/app/hr/page.tsx`

**Interfaces:**
- Consumes: `POST /api/sessions` (Task 4) via `multipart/form-data`
- Produces: Two-step HR scheduling wizard with all new fields

- [ ] **Step 1: Replace `hr/page.tsx` with full updated file**

```tsx
// frontend/app/hr/page.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useAuth } from './AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
const INVITE_BASE = process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ?? 'http://localhost:3000'

interface Session {
  id: string
  candidate_name: string
  candidate_email: string
  job_title: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  overall_score: number | null
  created_at: string
}

interface QuestionSet { id: string; role: string }

const JOB_ROLES = ['SDE', 'Data Analyst', 'Business Analyst', 'GenAI', 'UI/UX Designer', 'Custom']
const EXPERIENCE_OPTIONS = [
  { value: 'Fresher', label: 'Fresher' },
  { value: '1', label: '1 year' },
  { value: '2-3', label: '2–3 years' },
  { value: '3-5', label: '3–5 years' },
  { value: '5+', label: '5+ years' },
]

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  job_role: string
  job_role_custom: string
  experience_years: string
  linkedin_url: string
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

const EMPTY_FORM: CreateForm = {
  candidate_name: '', candidate_email: '', job_title: '',
  job_role: '', job_role_custom: '', experience_years: '',
  linkedin_url: '',
  jd_mode: 'text', jd_text: '', jd_file: null,
  resume_mode: 'text', resume_text: '', resume_file: null,
  use_question_set: true, question_set_id: '',
  custom_instructions: '',
}

const STATUS_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  pending:     { dot: 'bg-slate-500',  text: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/20' },
  in_progress: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  completed:   { dot: 'bg-green-500',  text: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
  cancelled:   { dot: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ScoreBar({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-600">—</span>
  const pct = (score / 10) * 100
  const color = score >= 7 ? 'bg-green-500' : score >= 4 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400">{score}/10</span>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="glass-card p-5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1.5 text-3xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
    </div>
  )
}

function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full transition-colors ${current === 1 ? 'bg-blue-500' : 'bg-white/20'}`} />
      <span className={`h-2 w-2 rounded-full transition-colors ${current === 2 ? 'bg-blue-500' : 'bg-white/20'}`} />
    </div>
  )
}

function DocField({
  label, mode, onModeChange, text, onTextChange, file, onFileChange,
}: {
  label: string
  mode: 'text' | 'pdf'
  onModeChange: (m: 'text' | 'pdf') => void
  text: string
  onTextChange: (v: string) => void
  file: File | null
  onFileChange: (f: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-sm text-slate-400">{label}</label>
        <div className="flex rounded-lg border border-white/10 overflow-hidden text-xs">
          {(['text', 'pdf'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={`px-2.5 py-1 font-medium transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {m === 'text' ? 'Paste Text' : 'Upload PDF'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'text' ? (
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          rows={4}
          placeholder={`Paste ${label.toLowerCase()} here…`}
          className="input-field resize-none"
        />
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/20 bg-white/[0.03] p-4 text-center hover:border-blue-500/40 hover:bg-blue-500/5 transition-all"
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={e => onFileChange(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-300">{file.name}</span>
              <span className="text-xs text-slate-500">({(file.size / 1024).toFixed(0)} KB)</span>
              <button
                type="button"
                onClick={ev => { ev.stopPropagation(); onFileChange(null) }}
                className="text-slate-500 hover:text-red-400 transition-colors"
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <svg className="h-6 w-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-xs text-slate-500">Click to upload PDF (max 10 MB)</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function HrPage() {
  const { accessToken } = useAuth()
  const router = useRouter()
  const [sessions, setSessions] = useState<Session[]>([])
  const [questionSets, setQuestionSets] = useState<QuestionSet[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(null)

  useEffect(() => {
    if (!accessToken) return
    const headers: HeadersInit = { Authorization: `Bearer ${accessToken}` }
    Promise.all([
      fetch(`${REST_BASE}/api/sessions`, { headers }).then(r => r.json()),
      fetch(`${REST_BASE}/api/question-sets`, { headers }).then(r => r.json()),
    ])
      .then(([sess, qs]) => {
        setSessions(Array.isArray(sess) ? (sess as Session[]) : [])
        setQuestionSets(Array.isArray(qs) ? (qs as QuestionSet[]) : [])
        setLoading(false)
      })
      .catch((err: unknown) => { console.error('[hr] failed to load:', err); setLoading(false) })
  }, [accessToken])

  const filteredQuestionSets = questionSets.filter(qs => {
    const role = form.job_role === 'Custom' ? form.job_role_custom : form.job_role
    return !role || qs.role.toLowerCase().includes(role.toLowerCase())
  })

  function setF<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function validateStep1(): string | null {
    if (!form.candidate_name.trim()) return 'Candidate name is required'
    if (!form.candidate_email.trim()) return 'Candidate email is required'
    if (!form.job_title.trim()) return 'Job title is required'
    if (!form.job_role) return 'Job role is required'
    if (form.job_role === 'Custom' && !form.job_role_custom.trim()) return 'Please enter the custom job role'
    if (!form.experience_years) return 'Experience level is required'
    return null
  }

  function handleNext() {
    const err = validateStep1()
    if (err) { setModalError(err); return }
    setModalError(null)
    setStep(2)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (form.use_question_set && !form.question_set_id) {
      setModalError('Please select a question set, or turn off the question bank toggle')
      return
    }

    // Enforce 10 MB limit client-side
    for (const file of [form.jd_file, form.resume_file]) {
      if (file && file.size > 10 * 1024 * 1024) {
        setModalError('PDF files must be under 10 MB')
        return
      }
    }

    setSubmitting(true)
    setModalError(null)

    const fd = new FormData()
    fd.append('candidate_name', form.candidate_name)
    fd.append('candidate_email', form.candidate_email)
    fd.append('job_title', form.job_title)
    fd.append('job_role', form.job_role === 'Custom' ? form.job_role_custom : form.job_role)
    fd.append('experience_years', form.experience_years)
    if (form.linkedin_url) fd.append('linkedin_url', form.linkedin_url)
    fd.append('use_question_set', String(form.use_question_set))
    if (form.use_question_set && form.question_set_id) fd.append('question_set_id', form.question_set_id)
    if (form.jd_mode === 'pdf' && form.jd_file) fd.append('jd_file', form.jd_file)
    else if (form.jd_mode === 'text' && form.jd_text) fd.append('jd_text', form.jd_text)
    if (form.resume_mode === 'pdf' && form.resume_file) fd.append('resume_file', form.resume_file)
    else if (form.resume_mode === 'text' && form.resume_text) fd.append('resume_text', form.resume_text)
    if (form.custom_instructions) fd.append('custom_instructions', form.custom_instructions)

    try {
      const res = await fetch(`${REST_BASE}/api/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd,
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { id, token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [{
        id,
        candidate_name: form.candidate_name,
        candidate_email: form.candidate_email,
        job_title: form.job_title,
        status: 'pending',
        overall_score: null,
        created_at: new Date().toISOString(),
      }, ...prev])
    } catch { setModalError('Network error') }
    finally { setSubmitting(false) }
  }

  function closeModal() {
    setShowModal(false)
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
    setStep(1)
  }

  const inProgress = sessions.filter(s => s.status === 'in_progress').length
  const completed = sessions.filter(s => s.status === 'completed').length
  const scores = sessions.map(s => s.overall_score).filter((s): s is number => s != null)
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—'

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      <header className="border-b border-white/8 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/20 border border-blue-500/20">
              <svg className="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
              </svg>
            </div>
            <span className="font-semibold">InterviewAI</span>
            <span className="rounded-full bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400 font-medium border border-blue-500/20">HR</span>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">+ New Interview</button>
            <button onClick={() => supabase.auth.signOut()} className="btn-ghost py-2 text-sm">Logout</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total Sessions" value={sessions.length} />
          <StatCard label="In Progress" value={inProgress} sub={inProgress > 0 ? 'Active now' : 'None active'} />
          <StatCard label="Completed" value={completed} />
          <StatCard label="Avg Score" value={avgScore} sub={scores.length > 0 ? `from ${scores.length} interviews` : 'No scores yet'} />
        </div>

        <div className="glass-card overflow-hidden">
          <div className="border-b border-white/8 px-5 py-4">
            <h2 className="font-semibold">Interview Sessions</h2>
          </div>
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-slate-500">No sessions yet.</p>
              <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">Create your first interview</button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-left">
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Candidate</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Role</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Score</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Created</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => {
                    const style = STATUS_STYLES[s.status] ?? STATUS_STYLES.pending
                    return (
                      <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                        <td className="px-5 py-3.5">
                          <p className="font-medium">{s.candidate_name}</p>
                          <p className="text-xs text-slate-600">{s.candidate_email}</p>
                        </td>
                        <td className="px-5 py-3.5 text-slate-400">{s.job_title}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                            {s.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-5 py-3.5"><ScoreBar score={s.overall_score} /></td>
                        <td className="px-5 py-3.5 text-slate-500 text-xs">{formatDate(s.created_at)}</td>
                        <td className="px-5 py-3.5">
                          <button
                            onClick={() => router.push(`/hr/sessions/${s.id}`)}
                            className="rounded-lg bg-white/5 border border-white/8 px-3 py-1.5 text-xs font-medium hover:bg-white/10 transition-all"
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-2xl p-6 animate-slide-up max-h-[90vh] overflow-y-auto">
            {inviteToken ? (
              <>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/15 border border-green-500/20">
                  <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                  </svg>
                </div>
                <h2 className="mb-1 text-lg font-bold text-green-400">Invite Created</h2>
                <p className="mb-4 text-sm text-slate-400">Copy this link and send it to the candidate:</p>
                <div className="mb-4 flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2">
                  <span className="flex-1 truncate text-xs text-slate-300">{`${INVITE_BASE}/interview/${inviteToken}`}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(`${INVITE_BASE}/interview/${inviteToken}`)}
                    className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium hover:bg-blue-500 transition-all"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => { setInviteToken(null); setModalError(null); setForm(EMPTY_FORM); setStep(1) }} className="btn-ghost flex-1 py-2 text-sm">Create Another</button>
                  <button onClick={closeModal} className="btn-primary flex-1 py-2 text-sm">Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-lg font-bold">
                    {step === 1 ? 'New Interview — Candidate Details' : 'New Interview — Interview Context'}
                  </h2>
                  <StepDots current={step} />
                </div>

                {step === 1 ? (
                  <div className="flex flex-col gap-4">
                    {([
                      { label: 'Candidate Name', key: 'candidate_name', type: 'text', placeholder: 'Jane Smith' },
                      { label: 'Candidate Email', key: 'candidate_email', type: 'email', placeholder: 'jane@example.com' },
                      { label: 'Job Title', key: 'job_title', type: 'text', placeholder: 'Senior Frontend Developer' },
                    ] as const).map(field => (
                      <div key={field.key}>
                        <label className="mb-1.5 block text-sm text-slate-400">{field.label} *</label>
                        <input
                          type={field.type}
                          value={form[field.key]}
                          onChange={e => setF(field.key, e.target.value)}
                          required
                          placeholder={field.placeholder}
                          className="input-field"
                        />
                      </div>
                    ))}

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Job Role *</label>
                      <select
                        value={form.job_role}
                        onChange={e => setF('job_role', e.target.value)}
                        required
                        className="input-field"
                      >
                        <option value="">Select role…</option>
                        {JOB_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      {form.job_role === 'Custom' && (
                        <input
                          type="text"
                          value={form.job_role_custom}
                          onChange={e => setF('job_role_custom', e.target.value)}
                          placeholder="Enter custom role name…"
                          className="input-field mt-2"
                        />
                      )}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Experience Level *</label>
                      <select
                        value={form.experience_years}
                        onChange={e => setF('experience_years', e.target.value)}
                        required
                        className="input-field"
                      >
                        <option value="">Select level…</option>
                        {EXPERIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">LinkedIn Profile URL <span className="text-slate-600">(optional)</span></label>
                      <input
                        type="url"
                        value={form.linkedin_url}
                        onChange={e => setF('linkedin_url', e.target.value)}
                        placeholder="https://linkedin.com/in/username"
                        className="input-field"
                      />
                    </div>

                    {modalError && (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button type="button" onClick={closeModal} className="btn-ghost flex-1 py-2 text-sm">Cancel</button>
                      <button type="button" onClick={handleNext} className="btn-primary flex-1 py-2 text-sm">Next →</button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleCreate} className="flex flex-col gap-5">
                    <DocField
                      label="Job Description"
                      mode={form.jd_mode}
                      onModeChange={m => setF('jd_mode', m)}
                      text={form.jd_text}
                      onTextChange={v => setF('jd_text', v)}
                      file={form.jd_file}
                      onFileChange={f => setF('jd_file', f)}
                    />

                    <DocField
                      label="Candidate Resume"
                      mode={form.resume_mode}
                      onModeChange={m => setF('resume_mode', m)}
                      text={form.resume_text}
                      onTextChange={v => setF('resume_text', v)}
                      file={form.resume_file}
                      onFileChange={f => setF('resume_file', f)}
                    />

                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">Use DB Question Bank</p>
                          <p className="text-xs text-slate-500 mt-0.5">Provides competency anchors to the AI interviewer</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setF('use_question_set', !form.use_question_set)}
                          className={`relative h-6 w-11 rounded-full transition-colors ${form.use_question_set ? 'bg-blue-600' : 'bg-white/20'}`}
                        >
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${form.use_question_set ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      {form.use_question_set && (
                        <div>
                          <label className="mb-1.5 block text-xs text-slate-400">Question Set (filtered by job role)</label>
                          <select
                            value={form.question_set_id}
                            onChange={e => setF('question_set_id', e.target.value)}
                            className="input-field text-sm"
                          >
                            <option value="">Select a question set…</option>
                            {filteredQuestionSets.map(qs => <option key={qs.id} value={qs.id}>{qs.role}</option>)}
                          </select>
                          {filteredQuestionSets.length === 0 && (
                            <p className="mt-1.5 text-xs text-amber-400">No question sets found for this role. Turn off the toggle for a fully AI-generated interview.</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Custom Instructions <span className="text-slate-600">(optional)</span></label>
                      <textarea
                        value={form.custom_instructions}
                        onChange={e => setF('custom_instructions', e.target.value)}
                        rows={3}
                        placeholder="Any extra guidance for the interviewer AI…"
                        className="input-field resize-none"
                      />
                    </div>

                    {modalError && (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button type="button" onClick={() => { setStep(1); setModalError(null) }} className="btn-ghost flex-1 py-2 text-sm">← Back</button>
                      <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2 text-sm">
                        {submitting ? 'Creating…' : 'Create & Send Invite'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Manual smoke test — open the HR modal**

Start the dev server:
```bash
cd frontend && npm run dev
```

Open `http://localhost:3000/hr` in the browser and log in.

Click `+ New Interview`. Verify:
- Step 1 shows: Name, Email, Job Title, Job Role dropdown, Experience Level, LinkedIn field
- Selecting "Custom" in Job Role reveals a text input
- Clicking "Next →" without required fields shows an error
- Filling Step 1 and clicking "Next →" advances to Step 2

In Step 2 verify:
- JD and Resume each have "Paste Text" / "Upload PDF" tab switchers
- Clicking "Upload PDF" shows a file drop zone; selecting a file shows name + size + X
- The question bank toggle shows/hides the question set dropdown
- Question sets are filtered to match the job role selected in Step 1
- "← Back" returns to Step 1 with form data preserved
- Submitting with `use_question_set = true` and no question set selected shows an error

- [ ] **Step 4: Manual smoke test — create a real session**

Fill the full form and submit. Verify:
- Backend receives the POST at `localhost:3001/api/sessions`
- Invite link is displayed in the success state
- Session row in Supabase has all new fields populated correctly (check via dashboard)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/hr/page.tsx
git commit -m "feat: two-step HR wizard modal with JD, resume, job role, experience, and question bank toggle"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| DB columns: job_role, experience_years, jd_text, jd_file_uri, resume_text, resume_file_uri, linkedin_url, custom_instructions, use_question_set | Task 1 |
| DB columns: competency_ratings, verified_strengths, gaps, notable_signals, followup_areas | Task 1 |
| question_set_id made nullable | Task 1 |
| InterviewContext type | Task 2 |
| toExperienceLabel() mapping | Task 2 |
| buildSystemPromptText() — full adaptive prompt template | Task 2 |
| score_competency tool replaces score_answer | Task 2 |
| end_interview expanded payload | Task 2 |
| executeTool handles new tool names | Task 2 |
| createSession() accepts new fields | Task 3 |
| getSession() returns new fields | Task 3 |
| saveScore stores competency area | Task 3 |
| finalizeSession stores rich payload | Task 3 |
| multer + pdf-parse dependencies | Task 4 |
| PDF → Gemini Files API upload | Task 4 |
| fallback to pdf-parse on Files API failure | Task 4 |
| multipart POST /api/sessions route | Task 4 |
| systemInstruction with fileData parts | Task 5 |
| InterviewContext built from session fields | Task 5 |
| Two-step wizard modal | Task 6 |
| Job Role dropdown with Custom option | Task 6 |
| Experience Level dropdown | Task 6 |
| JD + Resume text/PDF tab switchers | Task 6 |
| PDF drop zone with file info + clear | Task 6 |
| Question bank toggle + filtered dropdown | Task 6 |
| Custom instructions field | Task 6 |
| FormData submission (no Content-Type header) | Task 6 |
| 10 MB client-side file size limit | Task 6 |

All spec requirements covered. No gaps found.
