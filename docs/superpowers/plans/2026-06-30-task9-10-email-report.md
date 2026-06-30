# Email Invites + Report Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement real Resend email invites (Task 9) and a post-interview report generator that computes suspicion score and overall score (Task 10).

**Architecture:** Task 9 replaces the `email.ts` stub with a Resend API call. Task 10 creates `report.ts` with deterministic flag-counting and score-averaging logic, then wires it into the WS close handler in `interviewRelay.ts` as a fire-and-forget call. The two tasks are independent — Task 10 does not depend on Task 9.

**Tech Stack:** `resend@^3.2.0` (already installed), `@supabase/supabase-js` (already installed), Express + TypeScript (existing backend).

## Global Constraints

- TypeScript strict mode — no `any`, no `// @ts-ignore`
- Verify: `cd backend && npx tsc --noEmit` — no errors after each task
- `resend` package is already in `backend/package.json` — do NOT run npm install
- `RESEND_API_KEY` and `FRONTEND_URL` must be added to `backend/.env.example`
- From address: `InterviewAI <interviews@wohlig.com>`
- Suspicion score is additive, capped at 100 — exact rules in Task 2
- `recommendation` field is set by Gemini's `end_interview` tool — report generator must NOT overwrite it
- No test runner — verify via TypeScript compilation only

---

## File Map

**Task 1 — Email:**
- Modify: `backend/src/services/email.ts` (replace stub with Resend implementation)
- Modify: `backend/.env.example` (add `RESEND_API_KEY=` and `FRONTEND_URL=`)

**Task 2 — Report Generator:**
- Create: `backend/src/services/report.ts`
- Modify: `backend/src/websocket/interviewRelay.ts` (add `generateReport` call in `ws.on('close')`)

---

## Task 1: Email Invites via Resend

**Files:**
- Modify: `backend/src/services/email.ts`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `emailService.sendInvite({ to, candidateName, jobTitle, token }): Promise<void>` — already imported and called in `backend/src/routes/sessions.ts`; this task replaces the stub body only, the signature is unchanged

**Context:** `backend/src/services/email.ts` currently exports a stub that just `console.log`s. `backend/src/routes/sessions.ts` already imports and calls `emailService.sendInvite(...)` after `POST /api/sessions`. The `resend` npm package (`^3.2.0`) is already installed.

- [ ] **Step 1: Add env vars to `backend/.env.example`**

Open `backend/.env.example` and add these two lines at the end:

```
RESEND_API_KEY=
FRONTEND_URL=http://localhost:3000
```

- [ ] **Step 2: Replace the full contents of `backend/src/services/email.ts`**

```typescript
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const BASE_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000'
const FROM = 'InterviewAI <interviews@wohlig.com>'

export const emailService = {
  async sendInvite({
    to,
    candidateName,
    jobTitle,
    token,
  }: {
    to: string
    candidateName: string
    jobTitle: string
    token: string
  }): Promise<void> {
    const link = `${BASE_URL}/interview/${token}`
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Your interview for ${jobTitle} at Wohlig`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #1e293b;">Hi ${candidateName},</h2>
          <p>You have been invited to complete an AI-powered interview for the <strong>${jobTitle}</strong> position at Wohlig Transformations.</p>
          <p>Click the button below to start your interview. The link is valid for 48 hours.</p>
          <a href="${link}" style="display: inline-block; margin: 24px 0; padding: 12px 28px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Start Interview
          </a>
          <p style="color: #64748b; font-size: 14px;">
            <strong>Before you begin:</strong><br />
            &bull; Use Google Chrome for the best experience<br />
            &bull; Find a quiet, well-lit location<br />
            &bull; Allow camera and microphone access when prompted<br />
            &bull; The interview takes approximately 45 minutes
          </p>
          <p style="color: #94a3b8; font-size: 12px;">
            If the button does not work, copy this link into Chrome:<br />
            <a href="${link}" style="color: #3b82f6;">${link}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="color: #94a3b8; font-size: 12px;">This is an automated message from InterviewAI by Wohlig Transformations. Do not reply to this email.</p>
        </div>
      `,
    })
  },
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/email.ts backend/.env.example
git commit -m "feat: implement Resend email invite with HTML template"
```

---

## Task 2: Report Generator — Suspicion Score + Overall Score

**Files:**
- Create: `backend/src/services/report.ts`
- Modify: `backend/src/websocket/interviewRelay.ts`

**Interfaces:**
- Consumes: Supabase service role client (direct, not via `supabaseService` — report runs server-side with no org scope)
- Produces: `generateReport(sessionId: string): Promise<void>` — called by `interviewRelay.ts` on WS close

**Context:** `backend/src/websocket/interviewRelay.ts` has a `ws.on('close', ...)` handler at line 107. After each interview ends (whether completed or disconnected mid-way), the report generator queries `proctoring_flags` and `transcript_turns` for the session, computes scores, and updates the `sessions` row. The `recommendation` column is set by Gemini's `end_interview` tool via `supabaseService.finalizeSession` — the report generator does NOT touch it.

**Suspicion scoring rules (additive, capped at 100):**
- `face_absent` count > 3: +20
- `face_multiple` count > 0: +30
- `tab_switch` count > 2: +15 per occurrence above 2 (e.g. 4 switches = +30)
- `gaze_away` count > 0: +10
- `copy_attempt`: +15 each
- `paste_attempt`: +20 each
- `fullscreen_exit`: +10 each, max 2 counted (i.e. max +20)
- `right_click`: +2 each
- `keyboard_shortcut`: +3 each
- Final value: `Math.min(total, 100)`

**Overall score rule:** average of `score` column values from `transcript_turns` where `role = 'candidate'` and `score IS NOT NULL`. Rounded to 1 decimal place. If no scored turns exist, leave `overall_score` unchanged (do not update the column).

- [ ] **Step 1: Create `backend/src/services/report.ts`**

```typescript
import { createClient } from '@supabase/supabase-js'

function getClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  return createClient(url, key)
}

interface FlagRow {
  flag_type: string
}

interface TurnRow {
  role: string
  score: number | null
}

function calcSuspicionScore(flags: FlagRow[]): number {
  const counts: Record<string, number> = {}
  for (const f of flags) counts[f.flag_type] = (counts[f.flag_type] ?? 0) + 1

  let score = 0

  if ((counts['face_absent'] ?? 0) > 3) score += 20
  if ((counts['face_multiple'] ?? 0) > 0) score += 30

  const extraTabs = Math.max(0, (counts['tab_switch'] ?? 0) - 2)
  score += extraTabs * 15

  if ((counts['gaze_away'] ?? 0) > 0) score += 10
  score += (counts['copy_attempt'] ?? 0) * 15
  score += (counts['paste_attempt'] ?? 0) * 20

  const cappedFullscreen = Math.min(counts['fullscreen_exit'] ?? 0, 2)
  score += cappedFullscreen * 10

  score += (counts['right_click'] ?? 0) * 2
  score += (counts['keyboard_shortcut'] ?? 0) * 3

  return Math.min(score, 100)
}

function calcOverallScore(turns: TurnRow[]): number | null {
  const scored = turns
    .filter(t => t.role === 'candidate' && t.score != null)
    .map(t => t.score as number)
  if (scored.length === 0) return null
  const avg = scored.reduce((a, b) => a + b, 0) / scored.length
  return Math.round(avg * 10) / 10
}

export async function generateReport(sessionId: string): Promise<void> {
  const supabase = getClient()

  const [{ data: flags, error: flagsErr }, { data: turns, error: turnsErr }] = await Promise.all([
    supabase.from('proctoring_flags').select('flag_type').eq('session_id', sessionId),
    supabase.from('transcript_turns').select('role, score').eq('session_id', sessionId),
  ])

  if (flagsErr) console.error('[Report] Failed to fetch flags:', flagsErr)
  if (turnsErr) console.error('[Report] Failed to fetch turns:', turnsErr)

  const suspicionScore = calcSuspicionScore((flags ?? []) as FlagRow[])
  const overallScore = calcOverallScore((turns ?? []) as TurnRow[])

  const update: Record<string, number> = { suspicion_score: suspicionScore }
  if (overallScore !== null) update.overall_score = overallScore

  const { error: updateErr } = await supabase.from('sessions').update(update).eq('id', sessionId)
  if (updateErr) {
    console.error('[Report] Failed to persist scores:', updateErr)
  } else {
    console.log(`[Report] session=${sessionId} suspicion=${suspicionScore} overall=${overallScore ?? 'n/a'}`)
  }
}
```

- [ ] **Step 2: Add the import to `backend/src/websocket/interviewRelay.ts`**

At the top of `backend/src/websocket/interviewRelay.ts`, after the existing imports, add:

```typescript
import { generateReport } from '../services/report'
```

The file currently starts with:
```typescript
import WebSocket from 'ws'
import {
  GoogleGenAI,
  ...
} from '@google/genai'
import { buildSystemPrompt, interviewerTools, executeTool } from '../agents/interviewer'
import { supabaseService } from '../services/supabase'
```

Add the new import after `import { supabaseService } from '../services/supabase'`:
```typescript
import { generateReport } from '../services/report'
```

- [ ] **Step 3: Update the `ws.on('close', ...)` handler in `interviewRelay.ts`**

Find this existing handler (around line 107):
```typescript
ws.on('close', () => {
  console.log(`[WS] Browser disconnected: session=${session.id}`)
  if (!sessionClosed) liveSession?.close()
})
```

Replace it with:
```typescript
ws.on('close', () => {
  console.log(`[WS] Browser disconnected: session=${session.id}`)
  if (!sessionClosed) liveSession?.close()
  generateReport(session.id).catch(err =>
    console.error('[Report] Failed to generate:', err),
  )
})
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/report.ts backend/src/websocket/interviewRelay.ts
git commit -m "feat: report generator — suspicion score and overall score on session close"
```
