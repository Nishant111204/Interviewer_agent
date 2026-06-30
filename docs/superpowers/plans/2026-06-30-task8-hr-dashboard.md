# HR Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the HR-facing dashboard — login, sessions list with invite creation, and session detail with transcript/scores/flags.

**Architecture:** Supabase Auth handles HR login; the frontend passes Supabase `access_token` as Bearer to the existing Express backend. The backend auth middleware is updated to verify Supabase JWTs using `SUPABASE_JWT_SECRET` and look up `org_id` from the `hr_users` table. Six new frontend files under `app/hr/` + one new backend route file + three small backend modifications.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, `@supabase/supabase-js` (already in `frontend/package.json`), Express + `jsonwebtoken` (already in backend).

## Global Constraints

- All full-screen components: root `div` MUST include `bg-gray-950 text-white` in `className`
- TypeScript strict mode — no `any`, no `// @ts-ignore`
- Verify: `cd frontend && npx tsc --noEmit` (no test runner; use tsc for type checking)
- Verify backend: `cd backend && npx tsc --noEmit`
- Auth token: `Authorization: Bearer <access_token>` on every HR API call
- `SUPABASE_JWT_SECRET` replaces `JWT_SECRET` in backend auth middleware
- `NEXT_PUBLIC_BACKEND_API_URL` (already in `frontend/.env.local.example` as `http://localhost:3001`) is the REST base for HR pages
- `NEXT_PUBLIC_INTERVIEW_BASE_URL` must be added to `frontend/.env.local.example`
- No new npm packages — `@supabase/supabase-js` is already a frontend dep
- Dark theme throughout: `bg-gray-950`, inputs `bg-gray-800`, cards `bg-gray-900`

---

## File Map

**Backend (modify existing):**
- `backend/src/services/supabase.ts` — add `getHrUser` + `listQuestionSets` methods
- `backend/src/middleware/auth.ts` — verify Supabase JWT + DB lookup for `org_id`
- `backend/src/routes/sessions.ts` — `POST /` returns `{ id, token }` (currently only `{ id }`)
- `backend/src/index.ts` — mount `/api/question-sets` router

**Backend (create new):**
- `backend/src/routes/questionSets.ts` — `GET /api/question-sets` with auth

**Frontend (create new):**
- `frontend/lib/supabase.ts` — singleton browser client
- `frontend/app/hr/AuthContext.tsx` — React context: `{ accessToken }`
- `frontend/app/hr/layout.tsx` — auth guard, spinner, redirect to `/hr/login`
- `frontend/app/hr/login/page.tsx` — email + password login
- `frontend/app/hr/page.tsx` — sessions list + create modal
- `frontend/app/hr/sessions/[id]/page.tsx` — session detail

**Frontend (modify existing):**
- `frontend/.env.local.example` — add `NEXT_PUBLIC_INTERVIEW_BASE_URL`

---

## Task 1: Backend service layer — `getHrUser` + `listQuestionSets`

**Files:**
- Modify: `backend/src/services/supabase.ts`

**Interfaces:**
- Produces:
  - `supabaseService.getHrUser(userId: string): Promise<{ org_id: string } | null>`
  - `supabaseService.listQuestionSets(): Promise<Array<{ id: string; role: string }>>`

- [ ] **Step 1: Open `backend/src/services/supabase.ts` and locate the closing brace of the `supabaseService` object** (currently line ~179 — it ends with `},` after `saveFaceDescriptor`). Add the two new methods BEFORE the final closing `}`:

```typescript
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
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/supabase.ts
git commit -m "feat: add getHrUser and listQuestionSets to supabaseService"
```

---

## Task 2: Backend auth middleware — Supabase JWT + `org_id` lookup

**Files:**
- Modify: `backend/src/middleware/auth.ts`

**Interfaces:**
- Consumes: `supabaseService.getHrUser(userId)` from Task 1
- Produces: `req.hrUserId: string`, `req.orgId: string` (same as before, but sourced differently)

**Context:** The current middleware reads `org_id` directly from the JWT payload (`payload.org_id`). Supabase JWTs do NOT include `org_id` — only `sub` (the user's UUID). The new middleware verifies the token with `SUPABASE_JWT_SECRET`, then looks up `org_id` from `hr_users` via `supabaseService.getHrUser`. The Express middleware stays synchronous at the signature level by using `.then()/.catch()` instead of `async/await`.

- [ ] **Step 1: Replace the full contents of `backend/src/middleware/auth.ts` with:**

```typescript
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

- [ ] **Step 2: Verify TypeScript**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/middleware/auth.ts
git commit -m "feat: update auth middleware to verify Supabase JWT and look up org_id from hr_users"
```

---

## Task 3: Backend route additions — question-sets + POST token + mount

**Files:**
- Create: `backend/src/routes/questionSets.ts`
- Modify: `backend/src/routes/sessions.ts` (line 32 only)
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes: `supabaseService.listQuestionSets()` from Task 1; `authMiddleware` from Task 2
- Produces:
  - `GET /api/question-sets` → `Array<{ id: string; role: string }>`
  - `POST /api/sessions` now returns `{ id: string; token: string }` (was `{ id: string }`)

- [ ] **Step 1: Create `backend/src/routes/questionSets.ts`:**

```typescript
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

- [ ] **Step 2: In `backend/src/routes/sessions.ts`, find line 32 (the `POST /` response) and change:**

```typescript
// Before:
res.status(201).json({ id: session.id })

// After:
res.status(201).json({ id: session.id, token: session.token })
```

- [ ] **Step 3: In `backend/src/index.ts`, add the import and mount. After the existing `import candidateRouter from './routes/candidate'` line, add:**

```typescript
import questionSetsRouter from './routes/questionSets'
```

Then after `app.use('/api/sessions', sessionsRouter)`, add:

```typescript
app.use('/api/question-sets', questionSetsRouter)
```

The result in `backend/src/index.ts` should look like:

```typescript
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { URL } from 'url'
import { handleInterviewSocket } from './websocket/interviewRelay'
import sessionsRouter from './routes/sessions'
import candidateRouter from './routes/candidate'
import questionSetsRouter from './routes/questionSets'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/api/sessions', sessionsRouter)
app.use('/candidate', candidateRouter)
app.use('/api/question-sets', questionSetsRouter)

const server = createServer(app)
// ... rest unchanged
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/questionSets.ts backend/src/routes/sessions.ts backend/src/index.ts
git commit -m "feat: add GET /api/question-sets route and return token from POST /api/sessions"
```

---

## Task 4: Frontend foundation — Supabase client, AuthContext, layout

**Files:**
- Create: `frontend/lib/supabase.ts`
- Create: `frontend/app/hr/AuthContext.tsx`
- Create: `frontend/app/hr/layout.tsx`

**Interfaces:**
- Produces:
  - `supabase` — imported as `import { supabase } from '../../lib/supabase'` (relative from `app/hr/`)
  - `AuthContext` — React context with `{ accessToken: string }`
  - `useAuth()` — hook returning `AuthContextValue`
  - `HrLayout` — default export, wraps all `/hr/*` routes

**Context:** The layout wraps ALL routes under `app/hr/` including `/hr/login`. The auth guard MUST check `pathname !== '/hr/login'` before redirecting, or it will loop. `accessToken` starts as `null` (resolving) — only while `null` do we show the spinner.

- [ ] **Step 1: Create `frontend/lib/supabase.ts`:**

```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
```

- [ ] **Step 2: Create `frontend/app/hr/AuthContext.tsx`:**

```tsx
'use client'

import { createContext, useContext } from 'react'

export interface AuthContextValue {
  accessToken: string
}

export const AuthContext = createContext<AuthContextValue>({ accessToken: '' })

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
```

- [ ] **Step 3: Create `frontend/app/hr/layout.tsx`:**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { AuthContext } from './AuthContext'

export default function HrLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  // null = still resolving; '' = on login page with no session; string = authenticated
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setAccessToken(session.access_token)
      } else if (pathname !== '/hr/login') {
        router.push('/hr/login')
      } else {
        setAccessToken('')
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        router.push('/hr/login')
      } else if (session) {
        setAccessToken(session.access_token)
      }
    })

    return () => subscription.unsubscribe()
  }, [router, pathname])

  if (accessToken === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ accessToken }}>
      {children}
    </AuthContext.Provider>
  )
}
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/supabase.ts frontend/app/hr/AuthContext.tsx frontend/app/hr/layout.tsx
git commit -m "feat: add Supabase client, AuthContext, and HR layout auth guard"
```

---

## Task 5: HR login page

**Files:**
- Create: `frontend/app/hr/login/page.tsx`

**Interfaces:**
- Consumes: `supabase` from `frontend/lib/supabase.ts`
- Produces: `/hr/login` route — redirects to `/hr` on successful login

- [ ] **Step 1: Create `frontend/app/hr/login/page.tsx`:**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../lib/supabase'

export default function HrLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (authError) {
      setError(authError.message)
    } else {
      router.push('/hr')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-sm rounded-xl bg-gray-900 p-8">
        <h1 className="mb-6 text-2xl font-bold">HR Login</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-sm text-gray-400">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-lg bg-blue-600 py-2 font-semibold transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/hr/login/page.tsx
git commit -m "feat: HR login page with Supabase email/password auth"
```

---

## Task 6: HR sessions list page with create modal

**Files:**
- Create: `frontend/app/hr/page.tsx`
- Modify: `frontend/.env.local.example` (add `NEXT_PUBLIC_INTERVIEW_BASE_URL`)

**Interfaces:**
- Consumes: `useAuth()` from `AuthContext.tsx`; `GET /api/sessions`; `GET /api/question-sets`; `POST /api/sessions`
- Produces: `/hr` route — sessions table + create interview modal

**Context:**
- `NEXT_PUBLIC_BACKEND_API_URL` is the REST base (already in `.env.local.example` as `http://localhost:3001`)
- `NEXT_PUBLIC_INTERVIEW_BASE_URL` is used to construct the invite link (e.g. `http://localhost:3000`)
- `POST /api/sessions` now returns `{ id, token }` (Task 3)
- Status badge CSS map: `pending` → gray, `in_progress` → blue + pulse, `completed` → green, `cancelled` → red

- [ ] **Step 1: Add `NEXT_PUBLIC_INTERVIEW_BASE_URL=http://localhost:3000` to `frontend/.env.local.example`**

- [ ] **Step 2: Create `frontend/app/hr/page.tsx`:**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useAuth } from './AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? 'http://localhost:3001'
const INVITE_BASE = process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ?? 'http://localhost:3000'

interface Session {
  id: string
  candidate_name: string
  job_title: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  overall_score: number | null
  created_at: string
}

interface QuestionSet {
  id: string
  role: string
}

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  question_set_id: string
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-blue-900 text-blue-300 animate-pulse',
  completed: 'bg-green-900 text-green-300',
  cancelled: 'bg-red-900 text-red-300',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const EMPTY_FORM: CreateForm = {
  candidate_name: '',
  candidate_email: '',
  job_title: '',
  question_set_id: '',
}

export default function HrPage() {
  const { accessToken } = useAuth()
  const router = useRouter()

  const [sessions, setSessions] = useState<Session[]>([])
  const [questionSets, setQuestionSets] = useState<QuestionSet[]>([])
  const [loading, setLoading] = useState(true)

  const [showModal, setShowModal] = useState(false)
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
      .catch(() => setLoading(false))
  }, [accessToken])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setModalError(null)
    try {
      const res = await fetch(`${REST_BASE}/api/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [
        {
          id: token,
          candidate_name: form.candidate_name,
          job_title: form.job_title,
          status: 'pending',
          overall_score: null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ])
    } catch {
      setModalError('Network error')
    } finally {
      setSubmitting(false)
    }
  }

  function closeModal() {
    setShowModal(false)
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
  }

  function handleCreateAnother() {
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-white">
      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">InterviewAI HR</h1>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500"
          >
            New Interview
          </button>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Sessions table */}
      {sessions.length === 0 ? (
        <p className="text-gray-500">No sessions yet. Create one using &ldquo;New Interview&rdquo;.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900 text-left text-gray-400">
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Job Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id} className="border-b border-gray-800 hover:bg-gray-900">
                  <td className="px-4 py-3 font-medium">{s.candidate_name}</td>
                  <td className="px-4 py-3 text-gray-400">{s.job_title}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[s.status] ?? 'bg-gray-700 text-gray-300'}`}
                    >
                      {s.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{formatDate(s.created_at)}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {s.overall_score != null ? `${s.overall_score}/10` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => router.push(`/hr/sessions/${s.id}`)}
                      className="rounded bg-gray-800 px-3 py-1 text-xs hover:bg-gray-700"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Interview Modal */}
      {showModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-gray-900 p-6">
            {inviteToken ? (
              /* Success state — show invite link */
              <>
                <h2 className="mb-4 text-lg font-bold text-green-400">✅ Invite Created</h2>
                <p className="mb-2 text-sm text-gray-400">
                  Copy this link and send it to the candidate:
                </p>
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2">
                  <span className="flex-1 truncate text-xs text-gray-300">
                    {`${INVITE_BASE}/interview/${inviteToken}`}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard.writeText(`${INVITE_BASE}/interview/${inviteToken}`)
                    }
                    className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleCreateAnother}
                    className="flex-1 rounded-lg bg-gray-800 py-2 text-sm hover:bg-gray-700"
                  >
                    Create Another
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-semibold hover:bg-blue-500"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              /* Form state */
              <>
                <h2 className="mb-4 text-lg font-bold">New Interview</h2>
                <form onSubmit={handleCreate} className="flex flex-col gap-4">
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Candidate Name</label>
                    <input
                      type="text"
                      value={form.candidate_name}
                      onChange={e => setForm(f => ({ ...f, candidate_name: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Candidate Email</label>
                    <input
                      type="email"
                      value={form.candidate_email}
                      onChange={e => setForm(f => ({ ...f, candidate_email: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Job Title</label>
                    <input
                      type="text"
                      value={form.job_title}
                      onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Question Set</label>
                    <select
                      value={form.question_set_id}
                      onChange={e => setForm(f => ({ ...f, question_set_id: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select…</option>
                      {questionSets.map(qs => (
                        <option key={qs.id} value={qs.id}>
                          {qs.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  {modalError && <p className="text-sm text-red-400">{modalError}</p>}
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={closeModal}
                      className="flex-1 rounded-lg bg-gray-800 py-2 text-sm hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-50"
                    >
                      {submitting ? 'Creating…' : 'Create Invite'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/hr/page.tsx frontend/.env.local.example
git commit -m "feat: HR sessions list page with create interview modal"
```

---

## Task 7: HR session detail page

**Files:**
- Create: `frontend/app/hr/sessions/[id]/page.tsx`

**Interfaces:**
- Consumes: `useAuth()` from `AuthContext.tsx`; `GET /api/sessions/:id` → `{ session, turns, flags }`
- Produces: `/hr/sessions/[id]` route

**Context:**
- `GET /api/sessions/:id` returns `{ session: SessionRow, turns: Turn[], flags: Flag[] }` (from `supabaseService.getSessionDetail`)
- Score-note turns: `role='model'`, `text.startsWith('[Score:')` — rendered inline as indented italics
- Regular interviewer turns: `role='model'`, text does NOT start with `[Score:`
- Candidate turns: `role='candidate'`, may have `score: number | null`
- Suspicion displayed as `flags.length` with color: `<3` green, `3–6` amber, `≥7` red
- Recommendation: `hire` → green "✓ Hire", `reject` → red "✗ Reject", `review` → amber "○ Review"
- Flag severity badges: `low` → slate, `medium` → amber, `high` → red

- [ ] **Step 1: Create directory `frontend/app/hr/sessions/[id]/` and create `page.tsx`:**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? 'http://localhost:3001'

interface SessionRow {
  id: string
  candidate_name: string
  job_title: string
  status: string
  overall_score: number | null
  recommendation: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

interface Turn {
  id: string
  role: string
  text: string
  score: number | null
  ts: string
}

interface Flag {
  id: string
  flag_type: string
  severity: 'low' | 'medium' | 'high'
  ts: string
}

interface Detail {
  session: SessionRow
  turns: Turn[]
  flags: Flag[]
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-blue-900 text-blue-300',
  completed: 'bg-green-900 text-green-300',
  cancelled: 'bg-red-900 text-red-300',
}

const SEVERITY_BADGE: Record<string, string> = {
  low: 'bg-gray-700 text-gray-300',
  medium: 'bg-amber-900 text-amber-300',
  high: 'bg-red-900 text-red-300',
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function suspicionColor(count: number): string {
  if (count < 3) return 'text-green-400'
  if (count < 7) return 'text-amber-400'
  return 'text-red-400'
}

function RecommendationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-500">—</span>
  const map: Record<string, { label: string; cls: string }> = {
    hire: { label: '✓ Hire', cls: 'text-green-400' },
    reject: { label: '✗ Reject', cls: 'text-red-400' },
    review: { label: '○ Review', cls: 'text-amber-400' },
  }
  const entry = map[value.toLowerCase()]
  if (!entry) return <span>{value}</span>
  return <span className={`font-semibold ${entry.cls}`}>{entry.label}</span>
}

export default function SessionDetailPage({ params }: { params: { id: string } }) {
  const { accessToken } = useAuth()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!accessToken) return
    fetch(`${REST_BASE}/api/sessions/${params.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(async r => {
        if (r.status === 404) {
          setNotFound(true)
          return
        }
        const data = (await r.json()) as Detail
        setDetail(data)
      })
      .catch(() => setNotFound(true))
  }, [accessToken, params.id])

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <p className="text-gray-400">Session not found.</p>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  const { session, turns, flags } = detail

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-white">
      {/* Back */}
      <button
        type="button"
        onClick={() => router.push('/hr')}
        className="mb-6 text-sm text-gray-400 hover:text-white"
      >
        ← Back to Sessions
      </button>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{session.candidate_name}</h1>
          <p className="mt-1 text-gray-400">{session.job_title}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[session.status] ?? 'bg-gray-700 text-gray-300'}`}
          >
            {session.status.replace('_', ' ')}
          </span>
          <span className="text-xs text-gray-500">
            Created {formatDateTime(session.created_at)}
            {session.ended_at ? ` · Ended ${formatDateTime(session.ended_at)}` : ''}
          </span>
        </div>
      </div>

      {/* Score cards */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Overall Score</p>
          <p className="text-2xl font-bold">
            {session.overall_score != null ? `${session.overall_score}/10` : '—'}
          </p>
        </div>
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Proctoring Flags</p>
          <p className={`text-2xl font-bold ${suspicionColor(flags.length)}`}>{flags.length}</p>
        </div>
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Recommendation</p>
          <p className="text-2xl font-bold">
            <RecommendationBadge value={session.recommendation} />
          </p>
        </div>
      </div>

      {/* Transcript */}
      <section className="mb-8">
        <h2 className="mb-4 text-lg font-semibold">Transcript</h2>
        {turns.length === 0 ? (
          <p className="text-gray-500">No transcript recorded.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {turns.map(turn => {
              const isScoreNote = turn.text.startsWith('[Score:')
              const isInterviewer = turn.role === 'model'

              if (isScoreNote) {
                return (
                  <div key={turn.id} className="pl-4 border-l border-gray-800">
                    <p className="text-xs italic text-gray-500">{turn.text}</p>
                  </div>
                )
              }

              return (
                <div key={turn.id}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`text-xs font-semibold ${isInterviewer ? 'text-blue-400' : 'text-gray-400'}`}
                    >
                      {isInterviewer ? 'Interviewer' : 'Candidate'}
                    </span>
                    {!isInterviewer && turn.score != null && (
                      <span className="text-xs text-green-400">{turn.score}/10</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-gray-200">{turn.text}</p>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Proctoring Flags */}
      <section>
        <h2 className="mb-4 text-lg font-semibold">Proctoring Flags</h2>
        {flags.length === 0 ? (
          <p className="text-gray-500">No proctoring flags recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900 text-left text-gray-400">
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Severity</th>
                </tr>
              </thead>
              <tbody>
                {flags.map(flag => (
                  <tr key={flag.id} className="border-b border-gray-800">
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">
                      {formatTime(flag.ts)}
                    </td>
                    <td className="px-4 py-2 capitalize">
                      {flag.flag_type.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[flag.severity] ?? 'bg-gray-700 text-gray-300'}`}
                      >
                        {flag.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/hr/sessions/
git commit -m "feat: HR session detail page with transcript, scores, and proctoring flags"
```
