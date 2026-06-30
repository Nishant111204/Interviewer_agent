# InterviewAI — Full Redesign & Flow Repair

**Date:** 2026-06-30  
**Scope:** Frontend UI overhaul (premium corporate design), flow fixes (permissions, race conditions, phase transitions), backend bug fixes (RLS, duplicate migration, missing summary persistence, dependency cleanup).

---

## 1. Problem Statement

The platform is functionally correct in its core logic but suffers from:

1. **UI**: All pages are bare gray boxes with no visual identity or polish. The candidate interview experience is especially rough.
2. **Broken permission flow**: Camera and mic are requested in separate `getUserMedia` calls (selfie uses camera, then interview starts and requests mic separately) — two jarring browser prompts.
3. **Missing recovery UI**: Denied permissions show a raw error string with no guidance.
4. **No audio activity indicator**: No visual feedback when Gemini AI is speaking.
5. **Missing face guide**: No oval overlay in selfie capture; candidates don't know where to position their face.
6. **Duplicate selfie header**: `PreflightScreen` wraps `SelfieCapture` which has its own "Identity Verification" title — double-header.
7. **Backend gaps**: No RLS on `transcript_turns`, `proctoring_flags`, `question_sets`; `finalizeSession` silently drops Gemini's summary; `report.ts` creates its own Supabase client; `face_descriptor` column type mismatch between migrations; React in backend deps.

---

## 2. Design System (locked)

### Colors
```
Background:    #070d1a  (deep navy)
Surface:       #0e1829  (card base)
Glass:         rgba(255,255,255,0.04) + border rgba(255,255,255,0.08)
Accent:        #3b82f6  (blue-500)
Accent hover:  #2563eb  (blue-600)
Success:       #22c55e
Warning:       #f59e0b
Error:         #ef4444
Text primary:  #f8fafc
Text secondary:#94a3b8
Text muted:    #475569
```

### Typography
- Font: Inter (system fallback: -apple-system, BlinkMacSystemFont, sans-serif)
- Sizes follow Tailwind scale: text-xs through text-4xl

### Component tokens
- **Card**: `bg-[#0e1829] border border-white/8 rounded-2xl` with optional `backdrop-blur-sm`
- **Input**: `bg-white/5 border border-white/10 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20`
- **Button primary**: `bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold transition-all`
- **Button ghost**: `bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl`
- **Badge**: `rounded-full px-2.5 py-0.5 text-xs font-medium`

---

## 3. Architecture — No Changes

The existing architecture is correct and stays unchanged:
- Next.js 14 App Router frontend
- Express + WebSocket backend  
- Supabase (Postgres + Auth)
- Gemini Live API via `@google/genai`

---

## 4. Data Flow (Fixed)

### 4.1 Candidate Interview Flow (fixed)

```
/interview/[token]
  │
  ├── Phase: loading
  │     Validate token → fetch session details
  │     → 404/410: error phase
  │     → ok: permission phase
  │
  ├── Phase: permission  [NEW]
  │     Request camera + mic TOGETHER via getUserMedia({video, audio})
  │     → denied: show recovery guide (browser-specific instructions)
  │     → granted: store stream ref, advance to preflight
  │
  ├── Phase: preflight
  │     SelfieCapture — REUSES the granted stream (no new getUserMedia)
  │     Face oval guide overlay
  │     On capture confirmed → advance to interview
  │
  ├── Phase: interview
  │     InterviewRoom mounts, InterviewCapture.connect() called
  │     Audio worklet uses the already-granted mic stream
  │     Video uses the already-granted camera stream
  │     Speaking indicator shown during AI audio playback
  │
  ├── Phase: completed
  │     CompletedScreen variant="success"
  │
  └── Phase: error
        CompletedScreen variant="error" with message
```

### 4.2 HR Dashboard Flow (unchanged, improved UI)
```
/hr/login → Supabase auth.signInWithPassword → JWT stored
/hr → list sessions + stats summary row
/hr/sessions/[id] → session detail with transcript + flags
```

### 4.3 Backend Session Lifecycle (fixed)
```
POST /api/sessions
  → creates session (status=pending), sends email
  
GET  /candidate/sessions/:token
  → validates token, checks expires_at, status

PATCH /candidate/sessions/:token/descriptor
  → saves face embedding (idempotent)

WS  /interview/:token
  → validates session (pending + not expired)
  → markSessionStarted (status=in_progress)
  → Gemini Live session open
  → streams audio/video to Gemini
  → Gemini tool calls: score_answer, end_interview
  → on WS close: generateReport (suspicion + overall score)
  → finalizeSession now saves recommendation AND summary
```

---

## 5. Backend Fixes

### 5.1 Migration 003 — Fix schema
```sql
-- Fix face_descriptor type (align to float8[], drop if real[] was added)
-- Add summary column to sessions
alter table sessions add column if not exists summary text;

-- RLS on transcript_turns
alter table transcript_turns enable row level security;
create policy "hr_read_turns" on transcript_turns
  for select using (
    session_id in (
      select id from sessions where org_id in (
        select org_id from hr_users where id = auth.uid()
      )
    )
  );

-- RLS on proctoring_flags
alter table proctoring_flags enable row level security;
create policy "hr_read_flags" on proctoring_flags
  for select using (
    session_id in (
      select id from sessions where org_id in (
        select org_id from hr_users where id = auth.uid()
      )
    )
  );

-- RLS on question_sets  
alter table question_sets enable row level security;
create policy "hr_read_question_sets" on question_sets
  for select using (
    org_id in (select org_id from hr_users where id = auth.uid())
    or org_id is null
  );
```

### 5.2 `finalizeSession` — save summary
`supabase.ts`: update `finalizeSession` to persist `summary` in the sessions table.

### 5.3 `report.ts` — reuse singleton
Replace `getClient()` in `report.ts` with import from `../services/supabase`.

### 5.4 `package.json` cleanup
Remove `react`, `react-dom` from backend dependencies.

### 5.5 Env var consolidation
Standardise to `NEXT_PUBLIC_BACKEND_URL` everywhere — remove duplicate `NEXT_PUBLIC_WS_URL`. WS URL derived at runtime: `NEXT_PUBLIC_BACKEND_URL.replace('http', 'ws')`.

---

## 6. Frontend — Page-by-Page Spec

### 6.1 `app/page.tsx` — Landing page
- Full-height section: animated gradient background (radial blue glow on navy)
- Logo + "InterviewAI" wordmark
- Tagline: "AI-powered technical interviews. Fair, consistent, insightful."
- Two CTAs: "HR Login →" (primary) | "How it works" (ghost, scrolls to features)
- Features row (3 cards): Live AI Interviewer | Face Proctoring | Instant Reports
- Footer: Wohlig branding

### 6.2 `app/hr/login/page.tsx` — HR Login
- Centered glass card on animated gradient background
- Wohlig logo above form
- Email + password inputs with icons
- Error state with shake animation
- "Sign In" button with loading spinner

### 6.3 `app/hr/page.tsx` — HR Dashboard
- Top bar: logo + "New Interview" CTA + logout
- **Stats row** (4 cards): Total Sessions | In Progress (pulsing) | Completed | Avg Score
- Sessions table with:
  - Status badge with correct colors + pulse on in_progress
  - Score shown as colored bar (0–10)
  - "View" → session detail
- "New Interview" modal: unchanged logic, improved styling

### 6.4 `app/hr/sessions/[id]/page.tsx` — Session Detail
- Breadcrumb back link
- Hero: candidate name + job title + status badge + timestamps
- 3 score cards: Overall Score | Proctoring Flags | Recommendation
- Transcript as chat bubbles (AI left-aligned blue, candidate right-aligned white)
- Proctoring flags table with severity color coding

### 6.5 `components/interview/PreflightScreen.tsx` — 3-step flow
Remove duplicated intro text. Steps:
1. `PermissionStep` — camera+mic request (new component)
2. `SelfieStep` — face capture with oval guide
3. `ReadyStep` — confirmation screen before begin

### 6.6 `components/SelfieCapture.tsx` — Face Capture
- ACCEPTS existing MediaStream as `stream` prop (no new `getUserMedia`)
- **Does NOT stop stream tracks** — stream lifecycle is owned by parent (`InterviewPage`)
- Face oval SVG overlay on video to guide positioning
- Real-time status text: "Position your face in the oval" → "Face detected ✓"
- Clean single-action button: "Capture" → shows snapshot with "Retake / Continue"
- On confirm: calls `onCapture(descriptor)` only — does not touch the stream

### 6.7 `components/interview/InterviewRoom.tsx` — Live Interview
- Header bar: session info + timer + status indicator
- Left panel: camera feed in rounded card with overlay badge
- Right panel: transcript as chat bubbles (auto-scroll)
- **Speaking indicator**: animated 5-bar waveform shown during AI audio playback
- `onStop` → 2-step confirm modal (unchanged logic)

### 6.8 `components/interview/CompletedScreen.tsx` — End States
- Success: large checkmark animation + thank-you message + Wohlig branding
- Error: warning icon + specific message + contact recruiter CTA

---

## 7. New Component: `PermissionCheck`

Location: `components/interview/PermissionCheck.tsx`

**Purpose**: Requests camera + mic together before the selfie step. Returns the granted `MediaStream` to the parent so `SelfieCapture` can reuse it.

**States**:
- `idle` — Explain why permissions are needed, "Allow Camera & Mic" CTA
- `requesting` — Spinner while browser prompt is open
- `granted` — Auto-advances to next step
- `denied` — Show browser-specific recovery instructions (Chrome: Settings > Privacy > Camera)
- `error` — Generic error with retry

**Output**: calls `onGranted(stream: MediaStream)` on success.

---

## 8. Modified Hooks

### `useInterview.ts`
- Add `speakingRef` + `isSpeaking` state — set `true` while `playAudio()` is running, `false` on completion
- Expose `isSpeaking: boolean` in return type

### `capture.ts`
- `startAudio(existingStream?: MediaStream)` — if stream provided, use its audio track directly (no new `getUserMedia`); else request mic-only via `getUserMedia`
- `startVideo(videoEl, existingStream?: MediaStream)` — if stream provided, set `videoEl.srcObject` to it directly; else request camera-only via `getUserMedia`
- The combined stream from `PermissionCheck` (has both audio + video tracks) is passed once to `InterviewCapture` which uses audio for the worklet and video for the video element

---

## 9. Error Handling

| Scenario | Current | Fixed |
|---|---|---|
| Camera denied | Raw error string | PermissionCheck shows browser-specific guide |
| Mic denied | Raw error string | Same PermissionCheck (requested together) |
| No face in selfie | "No face detected" text | + "Try better lighting, face the camera" |
| WS connection lost | "Connection error" generic | "Connection lost. Please refresh and try again." |
| Token expired | 410 → "expired" text | CompletedScreen with "Contact your recruiter" |
| Session not found | 404 → blank | CompletedScreen variant="error" |

---

## 10. Files Changed

**New files:**
- `components/interview/PermissionCheck.tsx`
- `backend/supabase/migrations/003_rls_and_summary.sql`
- `docs/superpowers/specs/2026-06-30-interviewai-redesign-design.md`

**Modified files:**
- `frontend/.env.local.example` — consolidate env vars
- `app/page.tsx` — landing page
- `app/layout.tsx` — add Inter font
- `app/globals.css` — custom animations
- `app/hr/login/page.tsx` — premium redesign
- `app/hr/page.tsx` — stats row + improved table
- `app/hr/sessions/[id]/page.tsx` — chat bubbles + score cards
- `app/interview/[token]/InterviewPage.tsx` — add permission phase
- `components/SelfieCapture.tsx` — accept stream prop + oval guide
- `components/interview/PreflightScreen.tsx` — 3-step flow
- `components/interview/InterviewRoom.tsx` — speaking indicator
- `components/interview/CompletedScreen.tsx` — branded end states
- `hooks/useInterview.ts` — isSpeaking state
- `lib/capture.ts` — accept existing streams
- `backend/src/services/supabase.ts` — finalizeSession saves summary
- `backend/src/services/report.ts` — reuse supabase singleton
- `backend/package.json` — remove react/react-dom
