# InterviewAI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the InterviewAI platform with a premium corporate UI, fix broken permission flows, consolidate camera/mic requests, add speaking indicator, and repair backend schema/RLS gaps.

**Architecture:** 14 sequential tasks — backend fixes first (schema, RLS, singleton cleanup), then design system foundation, then UI tasks in dependency order (PermissionCheck → SelfieCapture → capture.ts → PreflightScreen → InterviewRoom → InterviewPage). Each task is independently testable via TypeScript compile + browser verification.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS 3, Supabase, Express + WebSocket, Google Gemini Live API.

## Global Constraints

- Tailwind only — no external UI library. No new npm packages unless explicitly listed.
- Background color: `#070d1a`. Card surface: `#0e1829`. Accent: `#3b82f6`.
- All border radius on cards: `rounded-2xl`. Inputs: `rounded-xl`. Buttons: `rounded-xl`.
- No `console.log` added to new code. Existing `console.error` calls are fine.
- Every component file starts with `'use client'` if it uses hooks or browser APIs.
- TypeScript strict mode — no `any` unless existing code already uses it.
- Stream lifecycle rule: `PermissionCheck` owns the combined `MediaStream`. `SelfieCapture` and `InterviewCapture` use tracks from it — they must NOT call `.stop()` on those tracks.

---

### Task 1: Backend Fixes

**Files:**
- Create: `backend/supabase/migrations/003_rls_and_summary.sql`
- Modify: `backend/src/services/supabase.ts`
- Modify: `backend/src/services/report.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `finalizeSession(sessionId, recommendation, summary)` — now saves summary to DB

- [ ] **Step 1: Write migration 003**

```sql
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
```

- [ ] **Step 2: Fix `finalizeSession` in `backend/src/services/supabase.ts`**

Replace the existing `finalizeSession` method (currently ignores `_summary`):

```typescript
async finalizeSession(sessionId: string, recommendation: string, summary: string) {
  const { error } = await getClient()
    .from('sessions')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      recommendation,
      summary,
    })
    .eq('id', sessionId)
  if (error) console.error('[DB] finalizeSession error:', error)
},
```

- [ ] **Step 3: Fix `report.ts` to reuse the shared supabase singleton**

Replace the local `getClient` function at the top of `backend/src/services/report.ts` with an import:

```typescript
import { createClient } from '@supabase/supabase-js'
// DELETE the local getClient() function — replace with:
import { supabaseService } from './supabase'
```

Then in `generateReport`, replace all `supabase.from(...)` calls with `getClient()` from the shared module. Since `supabaseService` doesn't expose `getClient` directly, change the approach — export the client getter:

In `backend/src/services/supabase.ts`, add at the bottom (after the `supabaseService` object):

```typescript
export { getClient as getSupabaseClient }
```

Then update the top of `backend/src/services/report.ts` to:

```typescript
import { getSupabaseClient } from './supabase'

interface FlagRow { flag_type: string }
interface TurnRow { role: string; score: number | null }

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
    .filter(t => t.role === 'user' && t.score != null)
    .map(t => t.score as number)
  if (scored.length === 0) return null
  return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10
}

export async function generateReport(sessionId: string): Promise<void> {
  const supabase = getSupabaseClient()
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
  if (updateErr) console.error('[Report] Failed to persist scores:', updateErr)
  else console.log(`[Report] session=${sessionId} suspicion=${suspicionScore} overall=${overallScore ?? 'n/a'}`)
}
```

- [ ] **Step 4: Clean `backend/package.json` — remove React and fix typo**

Remove `"react"`, `"react-dom"` from `dependencies`.
Remove `"@types/jsonwebtok"` from `devDependencies` (typo — this package doesn't exist; `jsonwebtoken` is already a dep and its types are bundled).

Run:
```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/backend
npm uninstall react react-dom
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/backend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer
git add backend/supabase/migrations/003_rls_and_summary.sql \
        backend/src/services/supabase.ts \
        backend/src/services/report.ts \
        backend/package.json backend/package-lock.json
git commit -m "fix: backend schema RLS, summary persistence, singleton reuse, dep cleanup"
```

---

### Task 2: Design System Foundation

**Files:**
- Modify: `frontend/tailwind.config.ts`
- Modify: `frontend/app/globals.css`
- Modify: `frontend/app/layout.tsx`
- Modify: `frontend/.env.local.example`

**Interfaces:**
- Produces: `animate-waveform`, `animate-fade-in`, `animate-slide-up` Tailwind classes; CSS custom properties; Inter font; consolidated env vars

- [ ] **Step 1: Extend `frontend/tailwind.config.ts`**

```typescript
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#070d1a',
          900: '#0e1829',
          800: '#162035',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
      animation: {
        waveform: 'waveform 1.2s ease-in-out infinite',
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        waveform: {
          '0%, 100%': { height: '4px' },
          '50%': { height: '20px' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
```

- [ ] **Step 2: Replace `frontend/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --bg: #070d1a;
    --surface: #0e1829;
    --border: rgba(255, 255, 255, 0.08);
    --accent: #3b82f6;
  }

  body {
    background-color: var(--bg);
    color: #f8fafc;
    font-family: var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  * {
    box-sizing: border-box;
  }
}

@layer components {
  .glass-card {
    @apply rounded-2xl border border-white/8 bg-white/[0.04] backdrop-blur-sm;
  }

  .input-field {
    @apply w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white
           placeholder-slate-500 transition-all outline-none
           focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20;
  }

  .btn-primary {
    @apply rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white transition-all
           hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50
           active:scale-[0.98];
  }

  .btn-ghost {
    @apply rounded-xl border border-white/10 bg-white/5 px-6 py-3 font-semibold
           text-slate-300 transition-all hover:bg-white/10 hover:text-white
           disabled:cursor-not-allowed disabled:opacity-50;
  }

  .status-badge {
    @apply inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium;
  }
}

/* Subtle grid background for hero sections */
.bg-grid {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
  background-size: 64px 64px;
}
```

- [ ] **Step 3: Update `frontend/app/layout.tsx` with Inter font**

```typescript
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = { title: 'InterviewAI — Wohlig' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-navy-950 text-white">{children}</body>
    </html>
  )
}
```

- [ ] **Step 4: Update `frontend/.env.local.example`**

Replace contents with:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
# Backend base URL — WS URL derived at runtime by replacing http with ws
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
NEXT_PUBLIC_INTERVIEW_BASE_URL=http://localhost:3000
```

- [ ] **Step 5: Update `frontend/.env.local` to match** (add the new key if missing)

Add `NEXT_PUBLIC_BACKEND_URL=http://localhost:3001` and remove `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_BACKEND_API_URL` if present.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer
git add frontend/tailwind.config.ts frontend/app/globals.css \
        frontend/app/layout.tsx frontend/.env.local.example
git commit -m "feat: design system — custom tokens, animations, Inter font, consolidated env vars"
```

---

### Task 3: Landing Page

**Files:**
- Modify: `frontend/app/page.tsx`

**Interfaces:**
- Consumes: design system classes from Task 2
- Produces: public-facing landing page at `/`

- [ ] **Step 1: Write `frontend/app/page.tsx`**

```typescript
import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-navy-950 text-white">
      {/* Hero */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center bg-grid">
        {/* Radial glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(59,130,246,0.18) 0%, transparent 70%)' }}
        />

        <div className="relative z-10 flex flex-col items-center gap-6 animate-fade-in">
          {/* Logo mark */}
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600/20 border border-blue-500/30">
            <svg className="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
            </svg>
          </div>

          <div>
            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">InterviewAI</h1>
            <p className="mt-4 max-w-lg text-lg text-slate-400">
              AI-powered technical interviews. Fair, consistent, and insightful — at any scale.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/hr/login" className="btn-primary text-center min-w-[160px]">
              HR Portal →
            </Link>
            <a href="#how-it-works" className="btn-ghost text-center min-w-[160px]">
              How it works
            </a>
          </div>

          <p className="text-xs text-slate-600">By Wohlig Transformations</p>
        </div>
      </section>

      {/* Features */}
      <section id="how-it-works" className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-12 text-center text-3xl font-bold">Everything you need</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                ),
                title: 'Live AI Interviewer',
                desc: 'Gemini conducts real-time voice interviews, adapts follow-ups, and scores answers automatically.',
              },
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                ),
                title: 'Face Proctoring',
                desc: 'MediaPipe gaze tracking and face verification detect impersonation and distraction in real time.',
              },
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                ),
                title: 'Instant Reports',
                desc: 'Per-question scores, suspicion analysis, and hire/reject recommendations ready the moment the interview ends.',
              },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="glass-card p-6 animate-slide-up">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/15 border border-blue-500/20">
                  <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    {icon}
                  </svg>
                </div>
                <h3 className="mb-2 font-semibold">{title}</h3>
                <p className="text-sm text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-8 text-center text-sm text-slate-600">
        © 2026 Wohlig Transformations. All rights reserved.
      </footer>
    </main>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app/page.tsx
git commit -m "feat: landing page with hero, features section, and HR portal CTA"
```

---

### Task 4: HR Login Page

**Files:**
- Modify: `frontend/app/hr/login/page.tsx`

- [ ] **Step 1: Rewrite `frontend/app/hr/login/page.tsx`**

```typescript
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
    if (authError) setError(authError.message)
    else router.push('/hr')
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-navy-950 px-4">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(59,130,246,0.12) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 w-full max-w-sm animate-slide-up">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/20 border border-blue-500/30">
            <svg className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-xs font-medium tracking-widest text-slate-500 uppercase">Wohlig</p>
            <h1 className="text-xl font-bold">InterviewAI</h1>
          </div>
        </div>

        <div className="glass-card p-8">
          <h2 className="mb-6 text-lg font-semibold">Sign in to HR Portal</h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="hr@company.com"
                className="input-field"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="input-field"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary mt-1 w-full">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in…
                </span>
              ) : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/app/hr/login/page.tsx
git commit -m "feat: HR login page redesign — glass card, radial glow, branded header"
```

---

### Task 5: PermissionCheck Component

**Files:**
- Create: `frontend/components/interview/PermissionCheck.tsx`

**Interfaces:**
- Produces: `<PermissionCheck onGranted={(stream: MediaStream) => void} />`

- [ ] **Step 1: Create `frontend/components/interview/PermissionCheck.tsx`**

```typescript
'use client'

import { useState, useCallback } from 'react'

interface PermissionCheckProps {
  onGranted: (stream: MediaStream) => void
}

type State = 'idle' | 'requesting' | 'denied' | 'error'

function isChrome() {
  return typeof navigator !== 'undefined' && /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)
}

function isSafari() {
  return typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
}

export function PermissionCheck({ onGranted }: PermissionCheckProps) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const requestPermissions = useCallback(async () => {
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      onGranted(stream)
    } catch (err) {
      const error = err as Error
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setState('denied')
      } else {
        setState('error')
        setErrorMsg(error.message || 'Could not access camera or microphone.')
      }
    }
  }, [onGranted])

  if (state === 'idle') {
    return (
      <div className="flex flex-col items-center gap-6 text-center animate-fade-in">
        <div className="flex gap-4">
          {/* Camera icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600/15 border border-blue-500/20">
            <svg className="h-7 w-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
            </svg>
          </div>
          {/* Mic icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600/15 border border-blue-500/20">
            <svg className="h-7 w-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
            </svg>
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold">Camera & Microphone Access</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-400">
            We need your camera to verify your identity and monitor the interview, and your microphone to hear your answers.
          </p>
        </div>

        <button onClick={requestPermissions} className="btn-primary min-w-[200px]">
          Allow Camera & Mic
        </button>

        <p className="text-xs text-slate-600">
          A browser permission prompt will appear. Click &ldquo;Allow&rdquo; to continue.
        </p>
      </div>
    )
  }

  if (state === 'requesting') {
    return (
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
        <p className="text-slate-400">Waiting for browser permission…</p>
        <p className="text-xs text-slate-600">Check for a prompt at the top of your browser window.</p>
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="flex flex-col items-center gap-5 text-center animate-fade-in max-w-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
          <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-red-400">Permission Denied</h2>
          <p className="mt-2 text-sm text-slate-400">
            You blocked camera or microphone access. To fix this:
          </p>
        </div>

        <div className="w-full rounded-xl border border-white/8 bg-white/[0.03] p-4 text-left text-sm text-slate-300 space-y-2">
          {isChrome() && (
            <>
              <p className="font-medium text-white">Chrome:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click the lock icon in your address bar</li>
                <li>Set Camera and Microphone to &ldquo;Allow&rdquo;</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
          {isSafari() && (
            <>
              <p className="font-medium text-white">Safari:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Go to Safari → Settings for This Website</li>
                <li>Set Camera and Microphone to &ldquo;Allow&rdquo;</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
          {!isChrome() && !isSafari() && (
            <>
              <p className="font-medium text-white">To fix:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click the camera/lock icon in your address bar</li>
                <li>Allow camera and microphone for this site</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
        </div>

        <button onClick={requestPermissions} className="btn-ghost">
          Try Again
        </button>
      </div>
    )
  }

  // error state
  return (
    <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
        <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
      </div>
      <div>
        <h2 className="text-xl font-semibold">Camera Error</h2>
        <p className="mt-2 text-sm text-slate-400">{errorMsg ?? 'Could not access your camera or microphone.'}</p>
        <p className="mt-1 text-xs text-slate-600">Make sure no other app is using your camera, then try again.</p>
      </div>
      <button onClick={requestPermissions} className="btn-primary">
        Try Again
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/components/interview/PermissionCheck.tsx
git commit -m "feat: PermissionCheck component — unified camera+mic grant with recovery guidance"
```

---

### Task 6: capture.ts — Stream Reuse

**Files:**
- Modify: `frontend/lib/capture.ts`

**Interfaces:**
- `startAudio(existingStream?: MediaStream): Promise<void>` — uses audio track from existing stream if provided
- `startVideo(videoEl: HTMLVideoElement, existingStream?: MediaStream): Promise<void>` — uses video track from existing stream if provided

- [ ] **Step 1: Update `startAudio` and `startVideo` in `frontend/lib/capture.ts`**

Replace the existing `startAudio` method:

```typescript
async startAudio(existingStream?: MediaStream): Promise<void> {
  if (existingStream) {
    // Reuse the audio track from the pre-granted stream
    this.micStream = new MediaStream(existingStream.getAudioTracks())
  } else {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    })
  }
  this.audioCtx = new AudioContext({ sampleRate: 16000 })
  await this.audioCtx.audioWorklet.addModule('/pcm-processor.js')
  const source = this.audioCtx.createMediaStreamSource(this.micStream)
  this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-processor')
  this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
    this._sendAudioChunk(e.data)
  }
  source.connect(this.workletNode)
}
```

Replace the existing `startVideo` method:

```typescript
async startVideo(videoEl: HTMLVideoElement, existingStream?: MediaStream): Promise<void> {
  if (existingStream) {
    // Reuse the video track from the pre-granted stream
    this.videoStream = new MediaStream(existingStream.getVideoTracks())
  } else {
    this.videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    })
  }
  videoEl.srcObject = this.videoStream
  await videoEl.play()

  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 240
  const ctx2d = canvas.getContext('2d')!
  this.videoInterval = setInterval(() => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    ctx2d.drawImage(videoEl, 0, 0, 320, 240)
    const jpeg = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
    this.ws.send(JSON.stringify({ type: 'video', data: jpeg }))
  }, 1000)
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/lib/capture.ts
git commit -m "feat: capture.ts accepts pre-granted MediaStream — no double permission prompts"
```

---

### Task 7: SelfieCapture Redesign

**Files:**
- Modify: `frontend/components/SelfieCapture.tsx`

**Interfaces:**
- Consumes: `stream: MediaStream` prop (from PermissionCheck — do NOT stop tracks)
- Produces: `onCapture(descriptor: Float32Array)` callback

- [ ] **Step 1: Rewrite `frontend/components/SelfieCapture.tsx`**

```typescript
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { initFaceApi, generateDescriptor } from '../lib/faceVerify'

interface SelfieCaptureProps {
  stream: MediaStream
  sessionToken: string
  onCapture: (descriptor: Float32Array) => void
}

type Phase =
  | { name: 'loading' }
  | { name: 'ready' }
  | { name: 'processing' }
  | { name: 'confirm'; descriptor: Float32Array; snapshotUrl: string }
  | { name: 'saving'; descriptor: Float32Array; snapshotUrl: string }
  | { name: 'error'; message: string }

export default function SelfieCapture({ stream, sessionToken, onCapture }: SelfieCaptureProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' })
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Attach the pre-granted stream to the video element — do NOT stop tracks
  useEffect(() => {
    let cancelled = false

    async function init() {
      const videoEl = videoRef.current
      if (!videoEl) return
      // Use the video track from the provided stream
      const videoOnlyStream = new MediaStream(stream.getVideoTracks())
      videoEl.srcObject = videoOnlyStream
      try {
        await videoEl.play()
        await initFaceApi()
        if (!cancelled) setPhase({ name: 'ready' })
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: `Setup failed: ${String(err)}` })
      }
    }

    void init()
    return () => { cancelled = true }
    // Stream tracks are NOT stopped here — PermissionCheck owns the stream lifecycle
  }, [stream])

  const takePhoto = useCallback(async () => {
    const videoEl = videoRef.current
    if (!videoEl) return
    setPhase({ name: 'processing' })

    const result = await generateDescriptor(videoEl)

    if (!result.ok) {
      const messages: Record<string, string> = {
        no_face: 'No face detected. Look directly at the camera in good lighting.',
        multiple_faces: 'Only one person should be visible — please try again.',
        error: 'Detection failed — please try again.',
      }
      setPhase({ name: 'error', message: messages[result.reason] ?? result.message })
      return
    }

    let snapshotUrl = ''
    const canvas = canvasRef.current
    if (canvas && videoEl.videoWidth) {
      canvas.width = videoEl.videoWidth
      canvas.height = videoEl.videoHeight
      canvas.getContext('2d')?.drawImage(videoEl, 0, 0)
      snapshotUrl = canvas.toDataURL('image/jpeg', 0.8)
    }
    setPhase({ name: 'confirm', descriptor: result.descriptor, snapshotUrl })
  }, [])

  const retake = useCallback(() => setPhase({ name: 'ready' }), [])

  const confirm = useCallback(async () => {
    if (phase.name !== 'confirm') return
    const { descriptor, snapshotUrl } = phase
    setPhase({ name: 'saving', descriptor, snapshotUrl })

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
      const res = await fetch(`${backendUrl}/candidate/sessions/${sessionToken}/descriptor`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor: Array.from(descriptor) }),
      })
      if (res.status === 409 || res.ok) {
        onCapture(descriptor)
        return
      }
      const body = await res.json().catch(() => ({}))
      setPhase({ name: 'error', message: (body as { error?: string }).error ?? 'Failed to save — try again.' })
    } catch (err) {
      setPhase({ name: 'error', message: `Network error: ${String(err)}` })
    }
  }, [phase, sessionToken, onCapture])

  const isShowingVideo = phase.name === 'ready' || phase.name === 'processing' || phase.name === 'loading' || phase.name === 'error'
  const isShowingSnapshot = phase.name === 'confirm' || phase.name === 'saving'

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {/* Video with face-guide oval overlay */}
      {isShowingVideo && (
        <div className="relative w-full overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: '4/3' }}>
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            muted
            playsInline
          />
          {/* Oval guide overlay */}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 75"
            preserveAspectRatio="none"
          >
            <defs>
              <mask id="oval-cutout">
                <rect width="100" height="75" fill="white" />
                <ellipse cx="50" cy="37" rx="30" ry="33" fill="black" />
              </mask>
            </defs>
            <rect width="100" height="75" fill="rgba(0,0,0,0.55)" mask="url(#oval-cutout)" />
            <ellipse
              cx="50" cy="37" rx="30" ry="33"
              fill="none"
              stroke={phase.name === 'ready' ? 'rgba(59,130,246,0.85)' : 'rgba(255,255,255,0.3)'}
              strokeWidth="0.5"
            />
          </svg>

          {/* Status text overlay */}
          <div className="absolute bottom-3 left-0 right-0 flex justify-center">
            <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-slate-300 backdrop-blur-sm">
              {phase.name === 'loading' && 'Loading face detection…'}
              {phase.name === 'ready' && 'Position your face in the oval'}
              {phase.name === 'processing' && 'Detecting face…'}
              {phase.name === 'error' && 'Try again'}
            </span>
          </div>
        </div>
      )}

      {/* Snapshot preview */}
      {isShowingSnapshot && (phase.name === 'confirm' || phase.name === 'saving') && phase.snapshotUrl && (
        <div className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: '4/3' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={phase.snapshotUrl} alt="Your selfie" className="h-full w-full object-cover" />
          {phase.name === 'saving' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/20 border-t-white" />
            </div>
          )}
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />

      {/* Error message */}
      {phase.name === 'error' && (
        <p className="text-center text-sm text-red-400">{phase.message}</p>
      )}

      {/* Action buttons */}
      <div className="flex w-full gap-3">
        {(phase.name === 'ready' || phase.name === 'error') && (
          <button
            onClick={phase.name === 'error' ? retake : takePhoto}
            disabled={phase.name === 'loading'}
            className="btn-primary flex-1"
          >
            {phase.name === 'error' ? 'Try Again' : 'Capture Photo'}
          </button>
        )}

        {phase.name === 'confirm' && (
          <>
            <button onClick={retake} className="btn-ghost flex-1">Retake</button>
            <button onClick={confirm} className="btn-primary flex-1">Looks good →</button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/components/SelfieCapture.tsx
git commit -m "feat: SelfieCapture redesign — face oval guide, accepts pre-granted stream"
```

---

### Task 8: useInterview — isSpeaking State

**Files:**
- Modify: `frontend/hooks/useInterview.ts`

**Interfaces:**
- Consumes: `preGrantedStream?: MediaStream` — new optional parameter
- Produces: `isSpeaking: boolean` in return value; passes stream to `capture.startAudio` and `capture.startVideo`

- [ ] **Step 1: Update `frontend/hooks/useInterview.ts`**

```typescript
'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import { InterviewCapture, type ProctoringEvent } from '../lib/capture'
import { attachProctoringListeners } from '../lib/proctoring'

export type InterviewStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error'

export interface TranscriptTurn {
  role: 'user' | 'model'
  text: string
  ts: string
}

export interface UseInterviewReturn {
  status: InterviewStatus
  transcript: TranscriptTurn[]
  flags: ProctoringEvent[]
  error: string | null
  isSpeaking: boolean
  videoRef: React.RefObject<HTMLVideoElement>
  start: () => Promise<void>
  stop: () => void
}

export function useInterview(
  sessionToken: string,
  referenceDescriptor: Float32Array | null,
  backendWsUrl: string,
  preGrantedStream?: MediaStream,
): UseInterviewReturn {
  const [status, setStatus] = useState<InterviewStatus>('idle')
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([])
  const [flags, setFlags] = useState<ProctoringEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)

  const captureRef = useRef<InterviewCapture | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onFlag = useCallback((event: ProctoringEvent) => {
    setFlags(prev => [...prev, event])
    captureRef.current?.sendFlag(event)
  }, [])

  const stop = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
    captureRef.current?.disconnect()
    captureRef.current = null
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
    setIsSpeaking(false)
    setStatus('ended')
  }, [])

  const start = useCallback(async () => {
    if (status !== 'idle') return

    const videoEl = videoRef.current
    if (!videoEl) {
      setError('Video element not mounted')
      setStatus('error')
      return
    }

    setStatus('connecting')
    setError(null)

    const capture = new InterviewCapture(sessionToken)
    captureRef.current = capture

    capture.onClose(() => {
      setStatus(prev => (prev === 'active' ? 'error' : prev))
      setError('Connection lost. Please refresh and try again.')
    })

    capture.onAudio((base64) => {
      setIsSpeaking(true)
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
      capture.playAudio(base64)
        .then(() => {
          speakingTimerRef.current = setTimeout(() => setIsSpeaking(false), 600)
        })
        .catch((err) => console.error('[useInterview] playAudio error:', err))
    })

    capture.onTranscript((role, text) => {
      setTranscript(prev => [
        ...prev,
        { role: role as 'user' | 'model', text, ts: new Date().toISOString() },
      ])
    })

    try {
      await capture.connect(backendWsUrl)
      await capture.startAudio(preGrantedStream)
      await capture.startVideo(videoEl, preGrantedStream)
      await capture.startFaceDetection(videoEl, onFlag)

      if (referenceDescriptor) {
        capture.startFaceVerification(referenceDescriptor, videoEl, onFlag)
      }

      detachRef.current = attachProctoringListeners(onFlag)
      setStatus('active')
    } catch (err) {
      capture.disconnect()
      captureRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [status, sessionToken, backendWsUrl, referenceDescriptor, preGrantedStream, onFlag])

  useEffect(() => {
    return () => {
      detachRef.current?.()
      captureRef.current?.disconnect()
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
    }
  }, [])

  return { status, transcript, flags, error, isSpeaking, videoRef, start, stop }
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/hooks/useInterview.ts
git commit -m "feat: useInterview — isSpeaking state, pre-granted stream passthrough"
```

---

### Task 9: PreflightScreen Redesign

**Files:**
- Modify: `frontend/components/interview/PreflightScreen.tsx`

**Interfaces:**
- Consumes: `PermissionCheck` (Task 5), `SelfieCapture` (Task 7)
- Consumes: `stream: MediaStream | null` prop — passed in from `InterviewPage`
- Produces: calls `onStreamGranted(stream)` and `onCapture(descriptor)` and `onBegin()`

- [ ] **Step 1: Rewrite `frontend/components/interview/PreflightScreen.tsx`**

```typescript
'use client'

import { useState } from 'react'
import { PermissionCheck } from './PermissionCheck'
import SelfieCapture from '../SelfieCapture'

interface PreflightScreenProps {
  token: string
  session: { candidateName: string; role: string }
  descriptor: Float32Array | null
  stream: MediaStream | null
  onStreamGranted: (stream: MediaStream) => void
  onCapture: (descriptor: Float32Array) => void
  onBegin: () => void
}

type Step = 'permissions' | 'selfie' | 'ready'

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'permissions', label: 'Permissions' },
    { key: 'selfie', label: 'Verify Identity' },
    { key: 'ready', label: 'Begin' },
  ]
  const currentIdx = steps.findIndex(s => s.key === current)

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all ${
            i < currentIdx
              ? 'bg-blue-600 text-white'
              : i === currentIdx
              ? 'border-2 border-blue-500 text-blue-400'
              : 'border border-white/20 text-slate-600'
          }`}>
            {i < currentIdx ? '✓' : i + 1}
          </div>
          <span className={`text-xs ${i === currentIdx ? 'text-white' : 'text-slate-600'}`}>
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <div className={`h-px w-6 ${i < currentIdx ? 'bg-blue-600' : 'bg-white/10'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

export function PreflightScreen({
  token,
  session,
  descriptor,
  stream,
  onStreamGranted,
  onCapture,
  onBegin,
}: PreflightScreenProps) {
  const [step, setStep] = useState<Step>(stream ? 'selfie' : 'permissions')

  function handleStreamGranted(s: MediaStream) {
    onStreamGranted(s)
    setStep('selfie')
  }

  function handleCapture(d: Float32Array) {
    onCapture(d)
    setStep('ready')
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-navy-950 px-6 py-12">
      {/* Background glow */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: 'radial-gradient(ellipse 70% 40% at 50% 0%, rgba(59,130,246,0.1) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 flex w-full max-w-md flex-col gap-8 animate-fade-in">
        {/* Header */}
        <div className="text-center">
          <p className="text-xs font-medium tracking-widest text-slate-500 uppercase mb-1">InterviewAI</p>
          <h1 className="text-2xl font-bold">Welcome, {session.candidateName}</h1>
          <p className="mt-1 text-slate-400">{session.role} Interview</p>
        </div>

        {/* Step indicator */}
        <div className="flex justify-center">
          <StepIndicator current={step} />
        </div>

        {/* Step content */}
        <div className="glass-card p-8">
          {step === 'permissions' && (
            <PermissionCheck onGranted={handleStreamGranted} />
          )}

          {step === 'selfie' && stream && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <h2 className="font-semibold">Identity Verification</h2>
                <p className="mt-1 text-sm text-slate-400">
                  We need a clear photo of your face. Position yourself in the oval.
                </p>
              </div>
              <SelfieCapture
                stream={stream}
                sessionToken={token}
                onCapture={handleCapture}
              />
            </div>
          )}

          {step === 'ready' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/15 border border-green-500/20">
                <svg className="h-8 w-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-semibold text-green-400">All set!</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Your identity has been verified. The AI interviewer is ready. Find a quiet space and click Begin when ready.
                </p>
              </div>
              <ul className="w-full space-y-2 text-left text-sm text-slate-400">
                {['Speak clearly and at a normal pace', 'Look at the camera while answering', 'The interview takes approximately 20 minutes'].map(tip => (
                  <li key={tip} className="flex items-start gap-2">
                    <span className="mt-0.5 text-blue-400">·</span>
                    {tip}
                  </li>
                ))}
              </ul>
              <button
                onClick={onBegin}
                disabled={descriptor === null}
                className="btn-primary w-full text-lg py-4"
              >
                Begin Interview →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/components/interview/PreflightScreen.tsx
git commit -m "feat: PreflightScreen redesign — 3-step flow with step indicator"
```

---

### Task 10: InterviewRoom Redesign

**Files:**
- Modify: `frontend/components/interview/InterviewRoom.tsx`

**Interfaces:**
- Consumes: `isSpeaking: boolean` — new prop from `useInterview`

- [ ] **Step 1: Rewrite `frontend/components/interview/InterviewRoom.tsx`**

```typescript
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
  isSpeaking: boolean
  videoRef: React.RefObject<HTMLVideoElement>
  onStop: () => void
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function InterviewRoom({
  session,
  status,
  transcript,
  flags,
  error,
  isSpeaking,
  videoRef,
  onStop,
}: InterviewRoomProps) {
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript.length])

  function handleStopClick() {
    if (showConfirm) { setShowConfirm(false); onStop() }
    else setShowConfirm(true)
  }

  return (
    <div className="flex h-screen flex-col bg-navy-950">
      {/* Header bar */}
      <header className="flex items-center justify-between border-b border-white/8 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{session.candidateName}</span>
          <span className="text-slate-600">·</span>
          <span className="text-sm text-slate-400">{session.role}</span>
        </div>

        <div className="flex items-center gap-4">
          {/* Timer */}
          <span className="font-mono text-sm text-slate-400">{formatElapsed(elapsed)}</span>

          {/* Status */}
          {status === 'connecting' && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
              <span className="text-xs text-slate-500">Connecting…</span>
            </div>
          )}
          {status === 'active' && !isSpeaking && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              <span className="text-xs text-green-400">Live</span>
            </div>
          )}
          {status === 'active' && isSpeaking && (
            <div className="flex items-center gap-2">
              {/* 5-bar waveform */}
              <div className="flex items-end gap-0.5 h-4">
                {[0, 1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className="w-0.5 rounded-full bg-blue-400 animate-waveform"
                    style={{ animationDelay: `${i * 0.12}s`, minHeight: '4px' }}
                  />
                ))}
              </div>
              <span className="text-xs text-blue-400">AI Speaking</span>
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-red-500" />
              <span className="text-xs text-red-400">Disconnected</span>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden gap-0 lg:gap-6 p-4 lg:p-6">
        {/* Left column: camera + controls */}
        <div className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
          {/* Error banner */}
          {status === 'error' && error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Camera feed */}
          <div className="relative overflow-hidden rounded-2xl bg-navy-900 border border-white/8">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full object-cover"
              style={{ aspectRatio: '4/3' }}
            />
            {/* Speaking glow overlay */}
            {isSpeaking && (
              <div className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-blue-500/40 ring-inset" />
            )}
            {/* Proctoring flag count */}
            {flags.length > 0 && (
              <div className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-amber-400 backdrop-blur-sm">
                ⚑ {flags.length}
              </div>
            )}
          </div>

          {/* Stop button */}
          <div className="mt-auto">
            {showConfirm ? (
              <div className="flex flex-col gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                <p className="text-center text-sm text-slate-400">End the interview?</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleStopClick}
                    className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-all"
                  >
                    Yes, end it
                  </button>
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 rounded-xl bg-white/5 py-2 text-sm font-semibold hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={handleStopClick}
                disabled={status !== 'active'}
                className="w-full rounded-xl border border-red-500/20 bg-red-500/10 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition-all disabled:cursor-not-allowed disabled:opacity-40"
              >
                End Interview
              </button>
            )}
          </div>
        </div>

        {/* Right column: transcript */}
        <div className="hidden lg:flex flex-1 flex-col min-h-0">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-600">
            Transcript
          </p>
          <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl bg-navy-900 border border-white/8 p-5">
            {transcript.length === 0 ? (
              <p className="text-sm italic text-slate-600 text-center mt-8">
                The interview will begin momentarily…
              </p>
            ) : (
              transcript.map((turn, i) => (
                <div
                  key={i}
                  className={`flex ${turn.role === 'model' ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      turn.role === 'model'
                        ? 'rounded-tl-sm bg-white/[0.06] border border-white/8 text-slate-200'
                        : 'rounded-tr-sm bg-blue-600/20 border border-blue-500/20 text-blue-100'
                    }`}
                  >
                    <p className={`mb-1 text-xs font-semibold ${turn.role === 'model' ? 'text-blue-400' : 'text-blue-300'}`}>
                      {turn.role === 'model' ? 'Interviewer' : 'You'}
                    </p>
                    {turn.text}
                  </div>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/components/interview/InterviewRoom.tsx
git commit -m "feat: InterviewRoom redesign — waveform speaking indicator, chat bubbles, timer"
```

---

### Task 11: CompletedScreen Redesign

**Files:**
- Modify: `frontend/components/interview/CompletedScreen.tsx`

- [ ] **Step 1: Rewrite `frontend/components/interview/CompletedScreen.tsx`**

```typescript
'use client'

interface CompletedScreenProps {
  variant: 'success' | 'error'
  session: { candidateName: string; role: string } | null
  message?: string
}

export function CompletedScreen({ variant, session, message }: CompletedScreenProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-navy-950 px-6 text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: variant === 'success'
            ? 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(34,197,94,0.08) 0%, transparent 70%)'
            : 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(239,68,68,0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 flex max-w-md flex-col items-center gap-6 animate-fade-in">
        {variant === 'success' ? (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-green-500/15 border border-green-500/20">
              <svg className="h-10 w-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold">Interview Complete</h1>
              {session && (
                <p className="mt-3 text-slate-400">
                  Thank you, <span className="text-white font-medium">{session.candidateName}</span>.
                  Your <span className="text-white font-medium">{session.role}</span> interview has been recorded and will be reviewed by our team.
                </p>
              )}
            </div>
            <div className="glass-card w-full p-4 text-sm text-slate-400">
              You will hear back from the recruiter within 3–5 business days.
            </div>
            <p className="text-sm text-slate-600">You may now close this tab.</p>
          </>
        ) : (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
              <svg className="h-10 w-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold">Something went wrong</h1>
              <p className="mt-3 text-slate-400">
                {message ?? 'An unexpected error occurred during your interview.'}
              </p>
            </div>
            <p className="text-sm text-slate-400">
              Please contact your recruiter and mention this error. They can send you a new interview link.
            </p>
          </>
        )}

        <p className="text-xs text-slate-700">InterviewAI by Wohlig Transformations</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/components/interview/CompletedScreen.tsx
git commit -m "feat: CompletedScreen redesign — branded end states with glassmorphism"
```

---

### Task 12: InterviewPage — Permission Phase + Wiring

**Files:**
- Modify: `frontend/app/interview/[token]/InterviewPage.tsx`

**Interfaces:**
- Consumes: `useInterview` with new `preGrantedStream` param (Task 8)
- Consumes: `PreflightScreen` with `stream` + `onStreamGranted` props (Task 9)
- Consumes: `InterviewRoom` with `isSpeaking` prop (Task 10)

- [ ] **Step 1: Rewrite `frontend/app/interview/[token]/InterviewPage.tsx`**

```typescript
'use client'

import { useState, useEffect } from 'react'
import { useInterview } from '../../../hooks/useInterview'
import { PreflightScreen } from '../../../components/interview/PreflightScreen'
import { InterviewRoom } from '../../../components/interview/InterviewRoom'
import { CompletedScreen } from '../../../components/interview/CompletedScreen'

type Phase = 'loading' | 'preflight' | 'interview' | 'completed' | 'error'

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
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
  const WS_URL = BACKEND_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')

  const { status, transcript, flags, error, isSpeaking, videoRef, start, stop } = useInterview(
    token,
    descriptor,
    WS_URL,
    stream ?? undefined,
  )

  // Validate token and fetch session details on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/candidate/sessions/${token}`)
      .then(res => {
        if (res.status === 404) throw new Error('Session not found or invalid link.')
        if (res.status === 410) throw new Error('This interview link has expired or was already used. Please contact your recruiter.')
        if (!res.ok) throw new Error('Failed to load session.')
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
  }, [token, BACKEND_URL])

  // Watch hook status during interview
  useEffect(() => {
    if (phase !== 'interview') return
    if (status === 'ended') setPhase('completed')
    if (status === 'error') {
      setErrorMessage(error ?? 'Connection error')
      setPhase('error')
    }
  }, [status, phase, error])

  // Auto-start once InterviewRoom mounts
  useEffect(() => {
    if (phase === 'interview' && status === 'idle') {
      void start()
    }
  }, [phase, status, start])

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
          <p className="text-sm text-slate-500">Loading your interview…</p>
        </div>
      </div>
    )
  }

  if (phase === 'preflight' && session) {
    return (
      <PreflightScreen
        token={token}
        session={session}
        descriptor={descriptor}
        stream={stream}
        onStreamGranted={setStream}
        onCapture={setDescriptor}
        onBegin={() => setPhase('interview')}
      />
    )
  }

  if (phase === 'interview') {
    return (
      <InterviewRoom
        session={session!}
        status={status}
        transcript={transcript}
        flags={flags}
        error={error}
        isSpeaking={isSpeaking}
        videoRef={videoRef}
        onStop={stop}
      />
    )
  }

  if (phase === 'completed') {
    return <CompletedScreen variant="success" session={session} />
  }

  return <CompletedScreen variant="error" session={session} message={errorMessage ?? undefined} />
}
```

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/app/interview/[token]/InterviewPage.tsx
git commit -m "feat: InterviewPage — permission phase, consolidated stream, isSpeaking wired"
```

---

### Task 13: HR Dashboard Redesign

**Files:**
- Modify: `frontend/app/hr/page.tsx`

- [ ] **Step 1: Rewrite `frontend/app/hr/page.tsx`**

Replace the full file. Key changes: stats row, improved table with score bar, consolidated env var.

```typescript
'use client'

import { useEffect, useState } from 'react'
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

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  question_set_id: string
}

const EMPTY_FORM: CreateForm = { candidate_name: '', candidate_email: '', job_title: '', question_set_id: '' }

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
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { id, token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [{
        id, candidate_name: form.candidate_name, candidate_email: form.candidate_email,
        job_title: form.job_title, status: 'pending', overall_score: null,
        created_at: new Date().toISOString(),
      }, ...prev])
    } catch { setModalError('Network error') }
    finally { setSubmitting(false) }
  }

  function closeModal() { setShowModal(false); setInviteToken(null); setModalError(null); setForm(EMPTY_FORM) }

  // Stats
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
      {/* Top bar */}
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
            <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">
              + New Interview
            </button>
            <button onClick={() => supabase.auth.signOut()} className="btn-ghost py-2 text-sm">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Stats */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total Sessions" value={sessions.length} />
          <StatCard label="In Progress" value={inProgress} sub={inProgress > 0 ? 'Active now' : 'None active'} />
          <StatCard label="Completed" value={completed} />
          <StatCard label="Avg Score" value={avgScore} sub={scores.length > 0 ? `from ${scores.length} interviews` : 'No scores yet'} />
        </div>

        {/* Sessions table */}
        <div className="glass-card overflow-hidden">
          <div className="border-b border-white/8 px-5 py-4">
            <h2 className="font-semibold">Interview Sessions</h2>
          </div>
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-slate-500">No sessions yet.</p>
              <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">
                Create your first interview
              </button>
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

      {/* Create Interview Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
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
                  <button onClick={() => { setInviteToken(null); setForm(EMPTY_FORM) }} className="btn-ghost flex-1 py-2 text-sm">Create Another</button>
                  <button onClick={closeModal} className="btn-primary flex-1 py-2 text-sm">Done</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="mb-5 text-lg font-bold">New Interview</h2>
                <form onSubmit={handleCreate} className="flex flex-col gap-4">
                  {([
                    { label: 'Candidate Name', key: 'candidate_name', type: 'text', placeholder: 'Jane Smith' },
                    { label: 'Candidate Email', key: 'candidate_email', type: 'email', placeholder: 'jane@example.com' },
                    { label: 'Job Title', key: 'job_title', type: 'text', placeholder: 'Senior Frontend Developer' },
                  ] as const).map(field => (
                    <div key={field.key}>
                      <label className="mb-1.5 block text-sm text-slate-400">{field.label}</label>
                      <input
                        type={field.type}
                        value={form[field.key]}
                        onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                        required
                        placeholder={field.placeholder}
                        className="input-field"
                      />
                    </div>
                  ))}
                  <div>
                    <label className="mb-1.5 block text-sm text-slate-400">Question Set</label>
                    <select
                      value={form.question_set_id}
                      onChange={e => setForm(f => ({ ...f, question_set_id: e.target.value }))}
                      required
                      className="input-field"
                    >
                      <option value="">Select a question set…</option>
                      {questionSets.map(qs => <option key={qs.id} value={qs.id}>{qs.role}</option>)}
                    </select>
                  </div>
                  {modalError && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                  )}
                  <div className="flex gap-3 pt-1">
                    <button type="button" onClick={closeModal} className="btn-ghost flex-1 py-2 text-sm">Cancel</button>
                    <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2 text-sm">
                      {submitting ? 'Creating…' : 'Create & Send Invite'}
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

- [ ] **Step 2: Verify + commit**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
git add frontend/app/hr/page.tsx
git commit -m "feat: HR dashboard redesign — stats row, score bar, branded header, glass modal"
```

---

### Task 14: Session Detail Redesign

**Files:**
- Modify: `frontend/app/hr/sessions/[id]/page.tsx`

- [ ] **Step 1: Rewrite `frontend/app/hr/sessions/[id]/page.tsx`**

```typescript
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'

interface SessionRow {
  id: string; candidate_name: string; job_title: string; status: string
  overall_score: number | null; suspicion_score: number | null
  recommendation: string | null; summary: string | null
  created_at: string; started_at: string | null; ended_at: string | null
}
interface Turn { id: string; role: string; text: string; score: number | null; ts: string }
interface Flag { id: string; flag_type: string; severity: 'low' | 'medium' | 'high'; ts: string }
interface Detail { session: SessionRow; turns: Turn[]; flags: Flag[] }

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  in_progress: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  completed: 'bg-green-500/10 border-green-500/20 text-green-400',
  cancelled: 'bg-red-500/10 border-red-500/20 text-red-400',
}
const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  medium: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  high: 'bg-red-500/10 border-red-500/20 text-red-400',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function RecommendationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-600">—</span>
  const v = value.toLowerCase()
  if (v.includes('strong hire') || v === 'hire') return <span className="font-semibold text-green-400">✓ {value}</span>
  if (v.includes('no hire') || v === 'reject') return <span className="font-semibold text-red-400">✗ {value}</span>
  return <span className="font-semibold text-amber-400">○ {value}</span>
}

function ScoreRing({ score, max = 10 }: { score: number | null; max?: number }) {
  if (score == null) return <span className="text-3xl font-bold text-slate-600">—</span>
  const color = score >= 7 ? 'text-green-400' : score >= 4 ? 'text-amber-400' : 'text-red-400'
  return <span className={`text-3xl font-bold ${color}`}>{score}/{max}</span>
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
        if (r.status === 404) { setNotFound(true); return }
        setDetail((await r.json()) as Detail)
      })
      .catch(() => setNotFound(true))
  }, [accessToken, params.id])

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="glass-card p-8 text-center">
          <p className="text-slate-400">Session not found.</p>
          <button onClick={() => router.push('/hr')} className="btn-ghost mt-4 py-2 text-sm">← Back</button>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
      </div>
    )
  }

  const { session, turns, flags } = detail
  const displayTurns = turns.filter(t => !t.text.startsWith('[Score:'))

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      <header className="border-b border-white/8 px-6 py-4">
        <div className="mx-auto max-w-5xl">
          <button onClick={() => router.push('/hr')} className="mb-4 flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors">
            ← Back to Sessions
          </button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{session.candidate_name}</h1>
              <p className="mt-0.5 text-slate-400">{session.job_title}</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[session.status] ?? STATUS_STYLES.pending}`}>
                {session.status.replace(/_/g, ' ')}
              </span>
              <span className="text-xs text-slate-600">
                {fmt(session.created_at)}
                {session.ended_at ? ` → ${fmt(session.ended_at)}` : ''}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        {/* Score cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Overall Score</p>
            <ScoreRing score={session.overall_score} />
          </div>
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Suspicion Score</p>
            <span className={`text-3xl font-bold ${
              (session.suspicion_score ?? 0) < 20 ? 'text-green-400'
              : (session.suspicion_score ?? 0) < 50 ? 'text-amber-400'
              : 'text-red-400'
            }`}>
              {session.suspicion_score ?? 0}
            </span>
            <span className="text-slate-600">/100</span>
          </div>
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Recommendation</p>
            <div className="text-xl font-bold mt-1"><RecommendationBadge value={session.recommendation} /></div>
          </div>
        </div>

        {/* Summary */}
        {session.summary && (
          <div className="glass-card p-5">
            <p className="mb-2 text-xs font-medium text-slate-500 uppercase tracking-wide">AI Summary</p>
            <p className="text-sm text-slate-300 leading-relaxed">{session.summary}</p>
          </div>
        )}

        {/* Transcript */}
        <section>
          <h2 className="mb-4 font-semibold">Transcript</h2>
          {displayTurns.length === 0 ? (
            <p className="text-sm text-slate-600">No transcript recorded.</p>
          ) : (
            <div className="glass-card p-5 space-y-4 max-h-[500px] overflow-y-auto">
              {displayTurns.map(turn => (
                <div key={turn.id} className={`flex ${turn.role === 'model' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    turn.role === 'model'
                      ? 'rounded-tl-sm bg-white/[0.05] border border-white/8 text-slate-200'
                      : 'rounded-tr-sm bg-blue-600/20 border border-blue-500/20 text-blue-100'
                  }`}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`text-xs font-semibold ${turn.role === 'model' ? 'text-blue-400' : 'text-blue-300'}`}>
                        {turn.role === 'model' ? 'Interviewer' : 'Candidate'}
                      </span>
                      {turn.role === 'user' && turn.score != null && (
                        <span className="text-xs text-green-400 font-medium">{turn.score}/10</span>
                      )}
                    </div>
                    {turn.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Proctoring Flags */}
        <section>
          <h2 className="mb-4 font-semibold">Proctoring Flags <span className="text-slate-600 font-normal text-sm">({flags.length})</span></h2>
          {flags.length === 0 ? (
            <div className="glass-card p-5">
              <p className="text-sm text-green-400">✓ No proctoring flags recorded.</p>
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-left">
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Time</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Event</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map(flag => (
                    <tr key={flag.id} className="border-b border-white/5">
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">{fmtTime(flag.ts)}</td>
                      <td className="px-5 py-3 capitalize text-slate-300">{flag.flag_type.replace(/_/g, ' ')}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[flag.severity] ?? SEVERITY_STYLES.low}`}>
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
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Verify all TypeScript compiles cleanly**

```bash
cd /Users/nishant.patil/Desktop/Gemini_interviewer/frontend && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/hr/sessions/[id]/page.tsx
git commit -m "feat: session detail redesign — chat bubbles, score cards, AI summary, flag table"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Backend RLS (transcript_turns, proctoring_flags, question_sets) → Task 1
- ✅ `summary` column + finalizeSession saves it → Task 1
- ✅ report.ts singleton reuse → Task 1
- ✅ React removed from backend deps → Task 1
- ✅ Design system (navy palette, animations, Inter font) → Task 2
- ✅ Landing page → Task 3
- ✅ HR login premium redesign → Task 4
- ✅ PermissionCheck with camera+mic together + denied recovery → Task 5
- ✅ capture.ts accepts pre-granted stream → Task 6
- ✅ SelfieCapture accepts stream prop, face oval, no stream stop → Task 7
- ✅ useInterview isSpeaking state + pre-granted stream passthrough → Task 8
- ✅ PreflightScreen 3-step flow → Task 9
- ✅ InterviewRoom speaking waveform, chat bubbles, timer → Task 10
- ✅ CompletedScreen branded end states → Task 11
- ✅ InterviewPage permission phase + consolidated env var → Task 12
- ✅ HR dashboard stats row + score bar → Task 13
- ✅ Session detail chat bubbles + summary + score cards → Task 14

**Type consistency check:**
- `useInterview` returns `isSpeaking` → used in Task 10 `InterviewRoom` prop → wired in Task 12 `InterviewPage` ✅
- `PreflightScreen` props `stream` + `onStreamGranted` → defined in Task 9, consumed in Task 12 ✅
- `SelfieCapture` accepts `stream: MediaStream` → defined Task 7, used Task 9 ✅
- `startAudio(existingStream?)` / `startVideo(videoEl, existingStream?)` → defined Task 6, called Task 8 ✅
- `NEXT_PUBLIC_BACKEND_URL` used consistently in Tasks 7, 12, 13, 14 ✅
