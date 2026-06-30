# Task 8: HR Dashboard Design Spec

**Date:** 2026-06-30
**Project:** InterviewAI — Wohlig Transformations

---

## Overview

The HR Dashboard gives internal HR users a web interface to:
1. Log in with their email and password (Supabase Auth)
2. View all interview sessions for their organisation
3. Drill into a session to see transcript, per-question scores, proctoring flags, and recommendation
4. Create a new interview invite (generates a tokenised URL and sends an email to the candidate)

Auth is handled entirely by Supabase Auth. The backend already has REST endpoints; this task wires them up to a Next.js frontend, updates the auth middleware to verify Supabase JWTs, and adds two small backend additions (`getHrUser` DB lookup, `GET /api/question-sets`).

---

## Tech Stack

- **Frontend:** Next.js 14 App Router, TypeScript, Tailwind CSS (`bg-gray-950` dark theme)
- **Auth:** `@supabase/supabase-js` browser client — `signInWithPassword`, `getSession`, `onAuthStateChange`
- **Backend:** Express, `jsonwebtoken`, existing `supabaseService`
- **DB:** Supabase Postgres — `hr_users`, `sessions`, `transcript_turns`, `proctoring_flags`, `question_sets`

---

## Global Constraints

- All full-screen components: root `div` MUST have `className` containing `bg-gray-950 text-white`
- All files are TypeScript; no `any` types where avoidable
- No new npm packages beyond `@supabase/supabase-js` (already a peer dep via backend — must be added to frontend's `package.json`)
- Auth token passed as `Authorization: Bearer <access_token>` on every API call
- `SUPABASE_JWT_SECRET` env var replaces `JWT_SECRET` in auth middleware (backend `.env`)
- Frontend env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_INTERVIEW_BASE_URL`
- No flash of unauthenticated content: layout shows a spinner until session check resolves
- Verify TypeScript compilation: `cd frontend && npx tsc --noEmit` (no test runner)

---

## Backend Changes

### 1. `backend/src/middleware/auth.ts` — update for Supabase JWTs

**Problem:** Current middleware expects `{ sub, org_id }` in the JWT payload. Supabase JWTs contain `sub` (user UUID) but not `org_id`. The `org_id` must be fetched from the `hr_users` table after token verification.

**Change:** Make `authMiddleware` verify with `SUPABASE_JWT_SECRET`, then call `supabaseService.getHrUser(payload.sub)` to resolve `org_id`. Use promise chaining (not `async/await`) to keep the Express signature synchronous.

```ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { supabaseService } from '../services/supabase'

export interface AuthRequest extends Request {
  hrUserId?: string
  orgId?: string
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }
  let payload: { sub: string }
  try {
    payload = jwt.verify(header.slice(7), process.env.SUPABASE_JWT_SECRET!) as { sub: string }
  } catch {
    res.status(401).json({ error: 'Invalid token' })
    return
  }
  supabaseService.getHrUser(payload.sub)
    .then(hrUser => {
      if (!hrUser) {
        res.status(403).json({ error: 'Not an HR user' })
        return
      }
      req.hrUserId = payload.sub
      req.orgId = hrUser.org_id
      next()
    })
    .catch(() => {
      res.status(500).json({ error: 'Auth check failed' })
    })
}
```

### 2. `backend/src/services/supabase.ts` — two new methods

**`getHrUser(userId: string)`** — looks up `org_id` from `hr_users` table:
```ts
async getHrUser(userId: string): Promise<{ org_id: string } | null> {
  const { data, error } = await getClient()
    .from('hr_users')
    .select('org_id')
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return { org_id: data.org_id as string }
},
```

**`listQuestionSets()`** — returns all question sets (shared templates, not org-scoped):
```ts
async listQuestionSets(): Promise<Array<{ id: string; role: string }>> {
  const { data, error } = await getClient()
    .from('question_sets')
    .select('id, role')
  if (error) throw error
  return (data ?? []) as Array<{ id: string; role: string }>
},
```

### 3. `backend/src/routes/sessions.ts` — two small changes

**Change A — `POST /api/sessions`:** Return `token` alongside `id` so the frontend can construct the invite URL immediately:
```ts
// Before:
res.status(201).json({ id: session.id })
// After:
res.status(201).json({ id: session.id, token: session.token })
```

**Change B — New `GET /api/question-sets` route** added BEFORE `router.use(authMiddleware)` (public read; question sets are non-sensitive metadata):
```ts
// Separate file: backend/src/routes/questionSets.ts
import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabaseService } from '../services/supabase'

const router = Router()
router.use(authMiddleware)

router.get('/', async (_req, res) => {
  try {
    const sets = await supabaseService.listQuestionSets()
    res.json(sets)
  } catch {
    res.status(500).json({ error: 'Failed to load question sets' })
  }
})

export default router
```

Mount in `backend/src/index.ts`:
```ts
import questionSetsRouter from './routes/questionSets'
app.use('/api/question-sets', questionSetsRouter)
```

---

## Frontend File Structure

```
frontend/
  lib/
    supabase.ts                   NEW — singleton browser Supabase client
  app/
    hr/
      AuthContext.tsx             NEW — React context: { accessToken }
      layout.tsx                  NEW — 'use client' auth guard, spinner, redirect
      page.tsx                    NEW — sessions list + create modal
      login/
        page.tsx                  NEW — email+password login form
      sessions/
        [id]/
          page.tsx                NEW — session detail
```

### `frontend/lib/supabase.ts`

Singleton browser client. Import this wherever Supabase is needed in the HR pages.

```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
```

### `frontend/app/hr/AuthContext.tsx`

```ts
'use client'
import { createContext, useContext } from 'react'

export interface AuthContextValue { accessToken: string }
export const AuthContext = createContext<AuthContextValue>({ accessToken: '' })
export function useAuth() { return useContext(AuthContext) }
```

### `frontend/app/hr/layout.tsx`

`'use client'`. **Critical:** This layout wraps ALL routes under `app/hr/`, including `app/hr/login/`. The auth guard MUST use `usePathname()` to skip the redirect when already on the login page, or it will loop infinitely.

On mount:
1. `supabase.auth.getSession()` — if no session AND `pathname !== '/hr/login'`, call `router.push('/hr/login')`, render nothing
2. If on `/hr/login` with no session: render `{children}` directly (let the login page handle itself)
3. If session: set `accessToken` state, render `<AuthContext.Provider value={{ accessToken }}>{children}</AuthContext.Provider>`
4. Subscribe to `supabase.auth.onAuthStateChange` — `SIGNED_OUT` event triggers `router.push('/hr/login')`
5. While resolving (before session check completes): render centered spinner on `bg-gray-950`

```tsx
// Root div during loading:
<div className="flex min-h-screen items-center justify-center bg-gray-950">
  <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
</div>
```

### `frontend/app/hr/login/page.tsx`

`'use client'`. Controlled form with `email` and `password` fields.

On submit:
```ts
const { error } = await supabase.auth.signInWithPassword({ email, password })
if (error) setErrorMsg(error.message)
else router.push('/hr')
```

UI:
- Root div: `className="flex min-h-screen items-center justify-center bg-gray-950"`
- Card: `className="w-full max-w-sm rounded-xl bg-gray-900 p-8"`
- Title: "HR Login"
- Inline error below password field if `errorMsg` is set
- Submit button: `bg-blue-600 hover:bg-blue-500`, disabled + shows "Signing in…" while loading

### `frontend/app/hr/page.tsx`

`'use client'`. Uses `useAuth()` to get `accessToken`.

**Data fetching:** On mount, `GET /api/sessions` with Bearer token → `setSessions(data)`. Also `GET /api/question-sets` → `setQuestionSets(data)` (needed for modal dropdown).

**Top bar:**
```
InterviewAI HR                        [New Interview]  [Logout]
```
- Logout: `supabase.auth.signOut()` (layout's `onAuthStateChange` handles redirect)

**Sessions table:**

| Candidate | Job Title | Status | Created | Score | Action |
|---|---|---|---|---|---|
| text | text | badge | formatted date | `x/10` or `—` | View button |

Status badge CSS:
- `pending`: `bg-gray-700 text-gray-300`
- `in_progress`: `bg-blue-900 text-blue-300 animate-pulse`
- `completed`: `bg-green-900 text-green-300`
- `cancelled`: `bg-red-900 text-red-300`

View button: `router.push('/hr/sessions/${session.id}')`

**Create Interview Modal** (`useState(false)` for `showModal`):

Fields: Candidate Name (text, required), Candidate Email (email, required), Job Title (text, required), Question Set (select, options from `/api/question-sets`, required).

On submit:
```ts
const res = await fetch(`${REST_BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ candidate_name, candidate_email, job_title, question_set_id }),
})
const { id, token } = await res.json()
```

On success: show invite URL panel inside modal:
```
✅ Invite created

Copy this link and send it to the candidate:
[ https://…/interview/{token} ]  [Copy]

[Create Another]  [Done]
```

`NEXT_PUBLIC_INTERVIEW_BASE_URL` + `/interview/` + token = invite URL.

`REST_BASE` is derived from `NEXT_PUBLIC_WS_URL` using the same replace pattern as `InterviewPage.tsx`:
```ts
const REST_BASE = (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001')
  .replace(/^wss:/, 'https:')
  .replace(/^ws:/, 'http:')
```

On error: inline error message in modal.

### `frontend/app/hr/sessions/[id]/page.tsx`

`'use client'`. Uses `useAuth()`. On mount: `GET /api/sessions/${id}` with Bearer → `setDetail({ session, turns, flags })`.

**Layout:**
```
← Back to Sessions

[Candidate Name] · [Job Title]    [Status badge]
Created: Jun 29, 11:00            Ended: Jun 29, 11:47

┌─────────────┐  ┌─────────────┐  ┌─────────────────┐
│ Overall     │  │ Suspicion   │  │ Recommendation  │
│   7.2/10    │  │ ⚠ 3 flags  │  │  ✓ Hire         │
└─────────────┘  └─────────────┘  └─────────────────┘

── Transcript ──────────────────────────────────────
Interviewer  Tell me about your experience with React…
Candidate    I've been using React for three years…     8/10
             └ [Score: 8/10] Strong technical answer…
Interviewer  What is the virtual DOM?
…

── Proctoring Flags ────────────────────────────────
Time        Event            Severity
11:23:01    Tab Switch       ⚠ Medium
11:30:44    Copy Attempt     🔴 High
```

**Score cards:**
- Overall Score: show `—` if null
- Suspicion: count of flags (`flags.length`), color: `<3` green, `3–6` amber, `≥7` red
- Recommendation: `hire` → green "✓ Hire", `reject` → red "✗ Reject", `review` → amber "○ Review", null → `—`

**Transcript rendering:**
- Filter out turns where `text.startsWith('[Score:')` from the main list — attach them as annotations below the preceding candidate turn
- Interviewer turns: `text-blue-300` label "Interviewer"
- Candidate turns: `text-gray-300` label "Candidate" + score chip `text-green-400 text-sm` if `turn.score != null`
- Score annotation: indented, `text-gray-500 text-xs italic`

**Flags table:**
- Severity badge: `low` → `bg-gray-700 text-gray-300`, `medium` → `bg-amber-900 text-amber-300`, `high` → `bg-red-900 text-red-300`
- Timestamp formatted as `HH:MM:SS` (local time from `flag.ts`)
- If no flags: "No proctoring flags recorded."

**Loading state:** spinner (same pattern as layout) while fetching.
**Error state:** "Session not found." centred on dark background.

---

## Environment Variables

### Backend `.env`

```
SUPABASE_JWT_SECRET=<from Supabase project → Settings → JWT Secret>
# (JWT_SECRET is removed; SUPABASE_JWT_SECRET replaces it)
```

### Frontend `.env.local` additions

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_INTERVIEW_BASE_URL=http://localhost:3000
```

Update `frontend/.env.local.example` with these three vars.

---

## Data Flow Summary

```
HR user → /hr/login → supabase.signInWithPassword
                    → access_token stored in Supabase session (localStorage)

HR user → /hr → layout.getSession → token → AuthContext
              → GET /api/sessions (Bearer token)
              → backend: jwt.verify(SUPABASE_JWT_SECRET) → hr_users lookup → org_id
              → sessions list

HR user → New Interview → POST /api/sessions → { id, token }
        → invite URL = NEXT_PUBLIC_INTERVIEW_BASE_URL + /interview/ + token

HR user → /hr/sessions/:id → GET /api/sessions/:id
        → { session, turns, flags }
```

---

## Out of Scope (deferred to later tasks)

- Email delivery (Task 9 — Resend integration); this task creates the session and returns the link, the modal shows it, but actual email sending relies on the existing stub
- Real-time updates / polling on the sessions list
- Pagination of sessions or transcript turns
- Role-based access control beyond org-level isolation
