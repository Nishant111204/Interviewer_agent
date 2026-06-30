# Task 7: Interview UI Components — Design Spec

**Date:** 2026-06-29
**Scope:** Candidate-facing interview flow. Three screens rendered on a single tokenized route: preflight check → live interview → completed/error. Consumes the `useInterview` hook (Task 6) and `SelfieCapture` component (Task 5).

---

## Context

Tasks 1–6 complete. What exists:

| Already built | Location |
|---|---|
| WebSocket relay + Gemini Live | `backend/src/websocket/interviewRelay.ts` |
| Supabase schema + REST API | `backend/src/routes/` |
| Candidate descriptor endpoint | `PATCH /candidate/sessions/:token/descriptor` |
| `SelfieCapture` component | `frontend/components/SelfieCapture.tsx` |
| `useInterview` hook | `frontend/hooks/useInterview.ts` |
| `InterviewCapture` + proctoring | `frontend/lib/capture.ts`, `frontend/lib/proctoring.ts` |

What is missing: a backend endpoint to read session details by token, and the three UI screens wired together.

---

## Architecture

### New files

**Backend** (1 new endpoint, existing router):

| Change | File | Description |
|---|---|---|
| Add route | `backend/src/routes/candidate.ts` | `GET /candidate/sessions/:token` |

**Frontend** (5 new files):

| File | Type | Description |
|---|---|---|
| `app/interview/[token]/page.tsx` | Server component | Reads `token` from params, renders `<InterviewPage>` |
| `app/interview/[token]/InterviewPage.tsx` | `'use client'` | Phase machine, session fetch, screen switcher |
| `components/interview/PreflightScreen.tsx` | `'use client'` | Selfie capture + begin button |
| `components/interview/InterviewRoom.tsx` | `'use client'` | Live interview: video, transcript, flags, stop |
| `components/interview/CompletedScreen.tsx` | `'use client'` | Thank-you or error end state |

No existing files modified except `backend/src/routes/candidate.ts` (new GET route added).

---

## Backend: `GET /candidate/sessions/:token`

**Location:** Add to `backend/src/routes/candidate.ts`, before the existing PATCH handler.

**Request:**
```
GET /candidate/sessions/:token
```

**Token validation:** Same as existing PATCH — regex `/^[a-f0-9]{64}$/`. Return 400 for invalid format.

**Response — 200 OK:**
```json
{ "candidateName": "Riya Sharma", "role": "Frontend Developer" }
```

**Error responses:**
```
404  { "error": "Session not found" }
410  { "error": "Session expired or already completed" }
400  { "error": "Invalid token format" }
```

Return **410** (Gone) when `status` is `completed` or `cancelled`, or when `expires_at < now()`. This lets the UI show a distinct "this session is no longer available" message rather than a generic "not found."

**No auth middleware** — same as PATCH. No rate limit needed (read-only, token is 64-char secret).

The Supabase query:
```ts
const { data, error } = await db.client
  .from('sessions')
  .select('candidate_name, question_set, status, expires_at')
  .eq('token', token)
  .single()
```
Extract `role` from `data.question_set.role` (the `QuestionSet` shape already has a `role` field).

---

## Phase Machine

`InterviewPage` owns a `phase` string and a `descriptor: Float32Array | null` ref/state.

```
loading      Fetch GET /candidate/sessions/:token
  ↓ 200
preflight    Show PreflightScreen; wait for onCapture
  ↓ descriptor set + "Begin Interview" clicked
interview    Call useInterview.start(); status: connecting → active
  ↓ stop() called, or status === 'ended'
completed    Show CompletedScreen (success variant)
  ↓ error at any phase (token invalid, WS error, etc.)
error        Show CompletedScreen (error variant)
```

`loading` and `error` from the session fetch map to immediate transitions:
- fetch 404/410/network error → `phase = 'error'` with a descriptive `errorMessage`
- fetch 200 → `phase = 'preflight'`

---

## `app/interview/[token]/page.tsx` — Server Component

```tsx
import { InterviewPage } from './InterviewPage'

interface Props {
  params: { token: string }
}

export default function Page({ params }: Props) {
  return <InterviewPage token={params.token} />
}
```

No data fetching in the server component — all fetching is client-side so the loading state renders immediately.

---

## `app/interview/[token]/InterviewPage.tsx`

**Props:** `{ token: string }`

**State:**
```ts
type Phase = 'loading' | 'preflight' | 'interview' | 'completed' | 'error'
const [phase, setPhase] = useState<Phase>('loading')
const [session, setSession] = useState<{ candidateName: string; role: string } | null>(null)
const [descriptor, setDescriptor] = useState<Float32Array | null>(null)
const [errorMessage, setErrorMessage] = useState<string | null>(null)
```

**Session fetch** — `useEffect` on mount:
```ts
useEffect(() => {
  const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'
  // derive REST base from WS URL
  const REST_BASE = WS_URL.replace(/^ws/, 'http')
  fetch(`${REST_BASE}/candidate/sessions/${token}`)
    .then(res => {
      if (res.status === 404) throw new Error('Session not found')
      if (res.status === 410) throw new Error('This interview link has expired or was already used')
      if (!res.ok) throw new Error('Failed to load session')
      return res.json()
    })
    .then(data => { setSession(data); setPhase('preflight') })
    .catch(err => { setErrorMessage(err.message); setPhase('error') })
}, [token])
```

**WS URL:** `const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'`

`NEXT_PUBLIC_WS_URL` is read client-side since this is a `'use client'` component. Document in `.env.local.example`.

**`useInterview` hook call** — always called (hooks can't be conditional), but `start()` is only invoked on user action in `interview` phase:
```ts
const { status, transcript, flags, error, videoRef, start, stop } = useInterview(
  token,
  descriptor,
  WS_URL,
)
```

When `status === 'ended'` or `status === 'error'` and phase is `interview`, transition:
```ts
useEffect(() => {
  if (phase !== 'interview') return
  if (status === 'ended') setPhase('completed')
  if (status === 'error') { setErrorMessage(error ?? 'Connection error'); setPhase('error') }
}, [status, phase, error])
```

**Begin Interview handler:**
```ts
function handleBegin() {
  setPhase('interview')
  // Do NOT call start() here — videoRef.current is null until <InterviewRoom>
  // mounts and its <video> element is attached to the DOM.
}
```

**Auto-start effect** — fires after `<InterviewRoom>` (and its `<video>`) mounts:
```ts
useEffect(() => {
  if (phase === 'interview' && status === 'idle') {
    start()
  }
}, [phase, status, start])
```

Sequence: `handleBegin` sets `phase → 'interview'` → React re-renders, mounts `<InterviewRoom>` with `<video ref={videoRef}>` → DOM updated, `videoRef.current` is non-null → effect fires → `start()` called successfully. The `status === 'idle'` guard prevents double-start if the effect re-fires on status changes.

**Render:**
```ts
if (phase === 'loading') return <LoadingSpinner />
if (phase === 'preflight') return <PreflightScreen ... />
if (phase === 'interview') return <InterviewRoom ... />
if (phase === 'completed') return <CompletedScreen success session={session} />
if (phase === 'error') return <CompletedScreen error message={errorMessage} />
```

**`LoadingSpinner`:** Inline — a centered `animate-spin` ring, 5 lines of JSX. Not a separate component (single use).

---

## `components/interview/PreflightScreen.tsx`

**Props:**
```ts
interface PreflightScreenProps {
  token: string
  session: { candidateName: string; role: string }
  onBegin: () => void        // called after descriptor set + button clicked
  onCapture: (descriptor: Float32Array) => void
  descriptor: Float32Array | null
}
```

**Layout (top to bottom):**
1. Header: `"Hello, {candidateName}"` + `"Role: {role}"` — calm, welcoming
2. Instructions: `"Before we begin, we need a clear photo of your face for identity verification."`
3. `<SelfieCapture sessionToken={token} onCapture={onCapture} />` — already handles all camera states internally
4. Begin button: `"Begin Interview"` — disabled and grayed out until `descriptor !== null`; enabled once selfie is captured

No re-capture once `descriptor` is set. SelfieCapture's own "Retake" flow handles that internally.

---

## `components/interview/InterviewRoom.tsx`

**Props:**
```ts
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

**Layout — two-column on desktop, stacked on mobile:**

```
┌─────────────────────┬────────────────────────┐
│  Camera feed        │  Transcript             │
│  <video>            │  (scrollable)           │
│                     │                         │
│  Status badge       │  [Interviewer]: ...     │
│  ● Live / spinner   │  [You]: ...             │
│                     │                         │
│  Flag chip          │                         │
│  "⚑ 3 flags"        │                         │
│                     │                         │
│  [End Interview]    │                         │
└─────────────────────┴────────────────────────┘
```

**Camera feed:**
- `<video ref={videoRef} autoPlay muted playsInline className="w-full rounded-lg bg-gray-900" />`
- Maintains aspect ratio; `object-cover`

**Status badge:**
- `connecting` → gray spinner + "Connecting…"
- `active` → green pulse dot + "Live"
- `error` → red dot + "Connection lost"

**Transcript panel:**
- Scrollable `div` with `overflow-y-auto max-h-[60vh]`
- Auto-scrolls to bottom on new entries — `useEffect` on `transcript.length` with `scrollIntoView`
- Each turn: role label (`Interviewer` in blue, `You` in gray) + text
- Empty state: `"The interview will begin shortly…"` in gray italic

**Flag chip:**
- Bottom-right of video column
- Hidden if `flags.length === 0`
- Shows count only: `⚑ {flags.length}` — no details visible to candidate (intentional)

**End Interview:**
- Single "End Interview" button in red
- One-click: shows inline confirmation — `"Are you sure? This will end the interview."` with Confirm / Cancel
- Confirm calls `onStop()`
- Available in `active` status only; disabled during `connecting`

**Error display:**
- If `status === 'error'` and `error` string present: red banner at top of room showing error message

---

## `components/interview/CompletedScreen.tsx`

**Props:**
```ts
interface CompletedScreenProps {
  variant: 'success' | 'error'
  session: { candidateName: string; role: string } | null
  message?: string   // error message, only shown for error variant
}
```

**Success variant:**
- Large checkmark icon (SVG, no external lib)
- `"Interview Complete"`
- `"Thank you, {candidateName}. Your {role} interview has been recorded and will be reviewed by our team."`
- `"You may close this tab."`

**Error variant:**
- Red X icon (SVG)
- `"Something went wrong"`
- `message` prop content (the error string)
- `"Please contact your recruiter if this issue persists."`

Both variants: centered, minimal, calm. No back/restart button.

---

## Environment

`frontend/.env.local.example` (create this file):
```
NEXT_PUBLIC_WS_URL=ws://localhost:3001
```

For production: `NEXT_PUBLIC_WS_URL=wss://api.example.com`

---

## Error Handling

| Scenario | Handling |
|---|---|
| Token invalid format | `InterviewPage` fetch → 400 → error phase, "Session not found" |
| Token not found | fetch → 404 → error phase, "Session not found" |
| Session expired / completed | fetch → 410 → error phase, "This interview link has expired or was already used" |
| Network error on fetch | fetch catch → error phase, "Failed to load session" |
| Mic/camera denied | `useInterview.start()` throws → `status='error'` → `InterviewPage` useEffect → error phase |
| WS fails to connect | Same as above |
| WS drops mid-interview | `status='error'` → `InterviewPage` useEffect → error phase, shows error message |
| User closes tab | `useInterview` `useEffect` cleanup tears down audio/video/WS |

---

## Out of Scope (Task 7)

- Fullscreen enforcement — the proctoring listener already detects `fullscreen_exit`; Task 7 does not request fullscreen (could be a Task 7 extension if desired)
- `beforeunload` warning dialog — browser handles tab-close; hook cleanup handles teardown
- Audio visualizer / waveform — YAGNI for now
- Candidate ability to see their flag details — intentionally hidden
