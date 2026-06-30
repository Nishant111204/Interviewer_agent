# Task 7: Interview UI Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the candidate-facing interview flow — a tokenized route at `/interview/[token]` that cycles through three screens: selfie preflight, live interview room, and completed/error end state.

**Architecture:** A single Next.js dynamic route owns all state via a phase machine (`loading → preflight → interview → completed | error`). Screen components are pure presentational. The `useInterview` hook (Task 6) and `SelfieCapture` component (Task 5) are consumed as-is. One new backend GET endpoint validates the token and returns session details before the candidate can start.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS (dark theme: `bg-gray-950 text-white`), React hooks

## Global Constraints

- All `'use client'` components must have that directive on line 1
- Tailwind dark theme throughout: base is `bg-gray-950 text-white`; follow existing patterns from `layout.tsx`
- No external UI libraries — inline SVGs for icons, Tailwind for all styling
- TypeScript verification: `cd frontend && node_modules/.bin/tsc --noEmit` must pass with zero errors after each task
- Backend verification: `cd backend && node_modules/.bin/tsc --noEmit` must pass with zero errors after Task 1
- `SelfieCapture` is a **default export** — import as `import SelfieCapture from '../SelfieCapture'`
- `useInterview` exports are **named** — import as `import { useInterview, type InterviewStatus, type TranscriptTurn } from '../../../hooks/useInterview'`
- `ProctoringEvent` is `import type { ProctoringEvent } from '../../lib/capture'`
- WS URL: `const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'`
- REST base derived from WS URL: `WS_URL.replace(/^ws/, 'http')` (handles both `ws://→http://` and `wss://→https://`)
- No test runner — verify with TypeScript compilation only
- Commit after every task

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `backend/src/routes/candidate.ts` | Add `GET /candidate/sessions/:token` before the existing PATCH handler |
| Create | `frontend/components/interview/CompletedScreen.tsx` | Success and error end states |
| Create | `frontend/components/interview/PreflightScreen.tsx` | Selfie capture + Begin button |
| Create | `frontend/components/interview/InterviewRoom.tsx` | Live interview: video, transcript, flags, stop |
| Create | `frontend/app/interview/[token]/page.tsx` | Thin server component; passes token to client |
| Create | `frontend/app/interview/[token]/InterviewPage.tsx` | Phase machine; orchestrates all three screens |
| Create | `frontend/.env.local.example` | Documents `NEXT_PUBLIC_WS_URL` |

---

## Task 1: Backend — `GET /candidate/sessions/:token`

**Files:**
- Modify: `backend/src/routes/candidate.ts`

**Interfaces:**
- Consumes: `supabaseService.getSession(token)` — already exists, returns `{ id, status, expires_at, candidate_name, question_set }` or `null`
- Produces: `GET /candidate/sessions/:token` → `{ candidateName: string; role: string }` | 400 | 404 | 410

- [ ] **Step 1: Add the GET route**

Open `backend/src/routes/candidate.ts`. Add this block **before** the existing `router.patch(...)` line (after the `checkRateLimit` function):

```typescript
// GET /candidate/sessions/:token
// Returns session details so the candidate UI can greet by name and validate before selfie.
router.get('/sessions/:token', async (req: Request, res: Response) => {
  const { token } = req.params

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid token format' })
    return
  }

  const session = await supabaseService.getSession(token)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const isExpired = new Date(session.expires_at) <= new Date()
  const isFinished = session.status === 'completed' || session.status === 'cancelled'

  if (isExpired || isFinished) {
    res.status(410).json({ error: 'Session expired or already completed' })
    return
  }

  res.json({
    candidateName: session.candidate_name,
    role: session.question_set.role,
  })
})
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /path/to/project/backend && node_modules/.bin/tsc --noEmit
```

Expected: no output (zero errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/candidate.ts
git commit -m "feat: add GET /candidate/sessions/:token — returns candidateName and role"
```

---

## Task 2: `CompletedScreen.tsx`

**Files:**
- Create: `frontend/components/interview/CompletedScreen.tsx`

**Interfaces:**
- Consumes: nothing from other new tasks
- Produces:
  ```ts
  export function CompletedScreen(props: CompletedScreenProps): JSX.Element
  interface CompletedScreenProps {
    variant: 'success' | 'error'
    session: { candidateName: string; role: string } | null
    message?: string
  }
  ```

- [ ] **Step 1: Create the directory and file**

Create `frontend/components/interview/` directory (mkdir if it doesn't exist), then create `frontend/components/interview/CompletedScreen.tsx` with this content:

```tsx
'use client'

interface CompletedScreenProps {
  variant: 'success' | 'error'
  session: { candidateName: string; role: string } | null
  message?: string
}

export function CompletedScreen({ variant, session, message }: CompletedScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      {variant === 'success' ? (
        <>
          <svg
            className="h-16 w-16 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          </svg>
          <h1 className="text-3xl font-bold">Interview Complete</h1>
          {session && (
            <p className="max-w-md text-gray-400">
              Thank you, {session.candidateName}. Your {session.role} interview has been
              recorded and will be reviewed by our team.
            </p>
          )}
          <p className="text-sm text-gray-600">You may close this tab.</p>
        </>
      ) : (
        <>
          <svg
            className="h-16 w-16 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          </svg>
          <h1 className="text-3xl font-bold">Something went wrong</h1>
          {message && <p className="max-w-md text-gray-400">{message}</p>}
          <p className="text-sm text-gray-600">
            Please contact your recruiter if this issue persists.
          </p>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /path/to/project/frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/interview/CompletedScreen.tsx
git commit -m "feat: add CompletedScreen — success and error end states"
```

---

## Task 3: `PreflightScreen.tsx`

**Files:**
- Create: `frontend/components/interview/PreflightScreen.tsx`

**Interfaces:**
- Consumes:
  - `SelfieCapture` default export from `../SelfieCapture` — props: `{ sessionToken: string; onCapture: (descriptor: Float32Array) => void }`
- Produces:
  ```ts
  export function PreflightScreen(props: PreflightScreenProps): JSX.Element
  interface PreflightScreenProps {
    token: string
    session: { candidateName: string; role: string }
    descriptor: Float32Array | null
    onCapture: (descriptor: Float32Array) => void
    onBegin: () => void
  }
  ```

- [ ] **Step 1: Create `frontend/components/interview/PreflightScreen.tsx`**

```tsx
'use client'

import SelfieCapture from '../SelfieCapture'

interface PreflightScreenProps {
  token: string
  session: { candidateName: string; role: string }
  descriptor: Float32Array | null
  onCapture: (descriptor: Float32Array) => void
  onBegin: () => void
}

export function PreflightScreen({
  token,
  session,
  descriptor,
  onCapture,
  onBegin,
}: PreflightScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Hello, {session.candidateName}</h1>
        <p className="mt-1 text-gray-400">Role: {session.role}</p>
      </div>

      <p className="max-w-sm text-center text-sm text-gray-400">
        Before we begin, we need a clear photo of your face for identity verification.
      </p>

      <SelfieCapture sessionToken={token} onCapture={onCapture} />

      <button
        onClick={onBegin}
        disabled={descriptor === null}
        className="mt-2 rounded-lg bg-blue-600 px-8 py-3 font-semibold transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Begin Interview
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /path/to/project/frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/interview/PreflightScreen.tsx
git commit -m "feat: add PreflightScreen — selfie capture + begin button"
```

---

## Task 4: `InterviewRoom.tsx`

**Files:**
- Create: `frontend/components/interview/InterviewRoom.tsx`

**Interfaces:**
- Consumes:
  - `InterviewStatus` from `../../hooks/useInterview` — `'idle' | 'connecting' | 'active' | 'ended' | 'error'`
  - `TranscriptTurn` from `../../hooks/useInterview` — `{ role: 'user' | 'model'; text: string; ts: string }`
  - `ProctoringEvent` from `../../lib/capture` — `{ type: string; ts: string; [key: string]: unknown }`
- Produces:
  ```ts
  export function InterviewRoom(props: InterviewRoomProps): JSX.Element
  interface InterviewRoomProps {
    session: { candidateName: string; role: string }
    status: InterviewStatus
    transcript: TranscriptTurn[]
    flags: ProctoringEvent[]
    error: string | null
    videoRef: React.RefObject<HTMLVideoElement>
    onStop: () => void
  }
  ```

- [ ] **Step 1: Create `frontend/components/interview/InterviewRoom.tsx`**

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import type { InterviewStatus, TranscriptTurn } from '../../hooks/useInterview'
import type { ProctoringEvent } from '../../lib/capture'

interface InterviewRoomProps {
  session: { candidateName: string; role: string }
  status: InterviewStatus
  transcript: TranscriptTurn[]
  flags: ProctoringEvent[]
  error: string | null
  videoRef: React.RefObject<HTMLVideoElement>
  onStop: () => void
}

export function InterviewRoom({
  session,
  status,
  transcript,
  flags,
  error,
  videoRef,
  onStop,
}: InterviewRoomProps) {
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  // Auto-scroll transcript to bottom on new entries
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript.length])

  function handleStopClick() {
    if (showConfirm) {
      setShowConfirm(false)
      onStop()
    } else {
      setShowConfirm(true)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 p-4 lg:flex-row lg:gap-6 lg:p-8">
      {/* Left column: camera + controls */}
      <div className="flex flex-col gap-4 lg:w-80 lg:shrink-0">
        {/* Status badge */}
        <div className="flex items-center gap-2">
          {status === 'connecting' && (
            <>
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
              <span className="text-sm text-gray-400">Connecting…</span>
            </>
          )}
          {status === 'active' && (
            <>
              <div className="h-3 w-3 animate-pulse rounded-full bg-green-500" />
              <span className="text-sm text-green-400">Live</span>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="h-3 w-3 rounded-full bg-red-500" />
              <span className="text-sm text-red-400">Connection lost</span>
            </>
          )}
        </div>

        {/* Error banner */}
        {status === 'error' && error && (
          <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Camera feed */}
        <div className="relative overflow-hidden rounded-xl bg-gray-900">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full object-cover"
          />
          {/* Flag chip — discreet, count only */}
          {flags.length > 0 && (
            <div className="absolute bottom-3 right-3 rounded-full bg-gray-900/80 px-2.5 py-1 text-xs text-amber-400 backdrop-blur-sm">
              ⚑ {flags.length}
            </div>
          )}
        </div>

        {/* Stop / confirm */}
        <div className="flex flex-col gap-2">
          {showConfirm ? (
            <>
              <p className="text-center text-sm text-gray-400">
                Are you sure? This will end the interview.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleStopClick}
                  className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-semibold transition-colors hover:bg-red-500"
                >
                  Yes, end it
                </button>
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-lg bg-gray-800 py-2 text-sm font-semibold transition-colors hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={handleStopClick}
              disabled={status !== 'active'}
              className="w-full rounded-lg bg-red-700/40 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-700/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              End Interview
            </button>
          )}
        </div>
      </div>

      {/* Right column: transcript */}
      <div className="mt-6 flex flex-1 flex-col lg:mt-0">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Transcript — {session.role} interview
        </h2>
        <div className="flex-1 space-y-4 overflow-y-auto rounded-xl bg-gray-900 p-4 max-h-[70vh]">
          {transcript.length === 0 ? (
            <p className="text-sm italic text-gray-600">The interview will begin shortly…</p>
          ) : (
            transcript.map((turn, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span
                  className={`text-xs font-semibold ${
                    turn.role === 'model' ? 'text-blue-400' : 'text-gray-400'
                  }`}
                >
                  {turn.role === 'model' ? 'Interviewer' : 'You'}
                </span>
                <p className="text-sm leading-relaxed text-gray-200">{turn.text}</p>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /path/to/project/frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors. If you get `Property 'ref' does not exist on type...` for the `videoRef` prop, change the interface to `videoRef: React.Ref<HTMLVideoElement>` — but this should not happen since `useInterview` returns `React.RefObject<HTMLVideoElement>` which is assignable.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/interview/InterviewRoom.tsx
git commit -m "feat: add InterviewRoom — video feed, transcript panel, flag chip, stop confirm"
```

---

## Task 5: `InterviewPage.tsx` + `page.tsx` + env example

**Files:**
- Create: `frontend/app/interview/[token]/page.tsx`
- Create: `frontend/app/interview/[token]/InterviewPage.tsx`
- Create: `frontend/.env.local.example`

**Interfaces:**
- Consumes (all from earlier tasks):
  - `useInterview(token, descriptor, WS_URL)` from `../../../hooks/useInterview`
  - `PreflightScreen` from `../../../components/interview/PreflightScreen`
  - `InterviewRoom` from `../../../components/interview/InterviewRoom`
  - `CompletedScreen` from `../../../components/interview/CompletedScreen`
  - `GET /candidate/sessions/:token` → `{ candidateName: string; role: string }`
- Produces: the `/interview/[token]` route — the full candidate interview flow

- [ ] **Step 1: Create `frontend/.env.local.example`**

```
NEXT_PUBLIC_WS_URL=ws://localhost:3001
```

This documents the only environment variable the frontend needs.

- [ ] **Step 2: Create `frontend/app/interview/[token]/page.tsx`**

Create the directory `frontend/app/interview/[token]/` first, then:

```tsx
import { InterviewPage } from './InterviewPage'

interface Props {
  params: { token: string }
}

export default function Page({ params }: Props) {
  return <InterviewPage token={params.token} />
}
```

This is a server component (no `'use client'`). It reads `token` from the URL and passes it to the client component.

- [ ] **Step 3: Create `frontend/app/interview/[token]/InterviewPage.tsx`**

```tsx
'use client'

import { useState, useEffect } from 'react'
import { useInterview } from '../../../hooks/useInterview'
import { PreflightScreen } from '../../../components/interview/PreflightScreen'
import { InterviewRoom } from '../../../components/interview/InterviewRoom'
import { CompletedScreen } from '../../../components/interview/CompletedScreen'

type Phase = 'loading' | 'preflight' | 'interview' | 'completed' | 'error'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'

interface SessionDetails {
  candidateName: string
  role: string
}

interface InterviewPageProps {
  token: string
}

export function InterviewPage({ token }: InterviewPageProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [session, setSession] = useState<SessionDetails | null>(null)
  const [descriptor, setDescriptor] = useState<Float32Array | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { status, transcript, flags, error, videoRef, start, stop } = useInterview(
    token,
    descriptor,
    WS_URL,
  )

  // Fetch session details on mount — validates token before showing selfie screen
  useEffect(() => {
    const REST_BASE = WS_URL.replace(/^ws/, 'http')
    fetch(`${REST_BASE}/candidate/sessions/${token}`)
      .then(res => {
        if (res.status === 404) throw new Error('Session not found')
        if (res.status === 410) throw new Error('This interview link has expired or was already used')
        if (!res.ok) throw new Error('Failed to load session')
        return res.json() as Promise<SessionDetails>
      })
      .then(data => {
        setSession(data)
        setPhase('preflight')
      })
      .catch(err => {
        setErrorMessage((err as Error).message)
        setPhase('error')
      })
  }, [token])

  // Watch hook status while in interview phase — transition out when done or errored
  useEffect(() => {
    if (phase !== 'interview') return
    if (status === 'ended') {
      setPhase('completed')
    }
    if (status === 'error') {
      setErrorMessage(error ?? 'Connection error')
      setPhase('error')
    }
  }, [status, phase, error])

  // Auto-start once InterviewRoom mounts and <video ref={videoRef}> is in the DOM.
  // Called AFTER render so videoRef.current is non-null.
  useEffect(() => {
    if (phase === 'interview' && status === 'idle') {
      start()
    }
  }, [phase, status, start])

  // Loading spinner
  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  // Selfie + begin
  if (phase === 'preflight' && session) {
    return (
      <PreflightScreen
        token={token}
        session={session}
        descriptor={descriptor}
        onCapture={setDescriptor}
        onBegin={() => setPhase('interview')}
      />
    )
  }

  // Live interview
  if (phase === 'interview') {
    return (
      <InterviewRoom
        session={session!}
        status={status}
        transcript={transcript}
        flags={flags}
        error={error}
        videoRef={videoRef}
        onStop={stop}
      />
    )
  }

  // Interview ended cleanly
  if (phase === 'completed') {
    return <CompletedScreen variant="success" session={session} />
  }

  // Error at any phase
  return <CompletedScreen variant="error" session={session} message={errorMessage ?? undefined} />
}
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /path/to/project/frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors.

Common errors to watch for:
- `Property 'params' does not exist` — Next.js 14 passes params via the `Props` interface; the type definition in `page.tsx` covers this.
- `Type 'string' is not assignable to type 'never'` for `videoRef` — if this occurs, change `InterviewRoomProps.videoRef` type to `React.Ref<HTMLVideoElement>`.
- `Cannot find module '../../../hooks/useInterview'` — check path depth: `app/interview/[token]/InterviewPage.tsx` is 3 levels deep from `frontend/`, so `../../../hooks/` is correct.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/interview/ frontend/.env.local.example
git commit -m "feat: add /interview/[token] route — phase machine wiring preflight, room, completed"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `GET /candidate/sessions/:token` → `{ candidateName, role }` | Task 1 |
| 400 for invalid token format | Task 1 |
| 404 for not found | Task 1 |
| 410 for expired or completed session | Task 1 |
| `CompletedScreen` — success variant with candidateName and role | Task 2 |
| `CompletedScreen` — error variant with message | Task 2 |
| `PreflightScreen` — greeting with candidateName and role | Task 3 |
| `PreflightScreen` — embeds `SelfieCapture` | Task 3 |
| `PreflightScreen` — Begin button disabled until descriptor set | Task 3 |
| `InterviewRoom` — `<video ref={videoRef}>` camera feed | Task 4 |
| `InterviewRoom` — status badge (connecting/active/error) | Task 4 |
| `InterviewRoom` — transcript panel, auto-scroll | Task 4 |
| `InterviewRoom` — flag chip (count only, hidden at 0) | Task 4 |
| `InterviewRoom` — End Interview with confirm dialog | Task 4 |
| `InterviewRoom` — error banner when `status === 'error'` | Task 4 |
| Phase machine: `loading → preflight → interview → completed | error` | Task 5 |
| Session fetch on mount, 404/410/network error → error phase | Task 5 |
| `useInterview` called always (hook rule), `start()` via useEffect | Task 5 |
| Auto-start after `<InterviewRoom>` mounts (videoRef non-null) | Task 5 |
| `status === 'ended'` → completed phase | Task 5 |
| `status === 'error'` → error phase | Task 5 |
| WS URL from `NEXT_PUBLIC_WS_URL` env var, fallback `ws://localhost:3001` | Task 5 |
| REST base derived from WS URL with `.replace(/^ws/, 'http')` | Task 5 |
| `.env.local.example` documenting `NEXT_PUBLIC_WS_URL` | Task 5 |
| Thin server `page.tsx` passes token to client `InterviewPage` | Task 5 |

All spec requirements covered. ✓

### Type consistency check

- `CompletedScreenProps.session` is `{ candidateName: string; role: string } | null` in Task 2 — matches `session` state type in Task 5 ✓
- `PreflightScreenProps` in Task 3 exactly matches the props passed in Task 5's `<PreflightScreen>` call ✓
- `InterviewRoomProps` in Task 4 exactly matches the props passed in Task 5's `<InterviewRoom>` call ✓
- `videoRef` type: `useInterview` returns `React.RefObject<HTMLVideoElement>` (from `hooks/useInterview.ts` line 20); `InterviewRoomProps.videoRef` typed as `React.RefObject<HTMLVideoElement>` — assignable ✓
- `SelfieCapture` is default-imported in Task 3 — matches the `export default function SelfieCapture` in `components/SelfieCapture.tsx` ✓
- `useInterview` named imports in Task 5 match the named exports in `hooks/useInterview.ts` ✓

No placeholder. No TBD. ✓
