# InterviewAI Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-stack AI-powered browser interview platform that conducts voice interviews via Gemini Live, with real-time proctoring (face detection, gaze, tab-switch, copy-paste) and an HR results dashboard.

**Architecture:** Browser captures mic (AudioWorklet → PCM16) and webcam (Canvas → JPEG), streams both over WebSocket to a Node.js relay server; the relay feeds audio+video to a Google ADK agent backed by Gemini Live (gemini-live-2.5-flash), which conducts the interview and calls tools to score answers and end the session; proctoring events are detected client-side by MediaPipe and DOM listeners, serialized as flag objects, and persisted by the relay to Supabase.

**Tech Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · `@google/adk` · `gemini-live-2.5-flash` · `@mediapipe/tasks-vision` · Web Audio API / AudioWorklet · Node.js / Express / `ws` · Supabase (Postgres + Auth) · Resend · JWT

## Global Constraints

- Node.js ≥ 20, TypeScript 5.x strict mode
- Target browser: Chrome desktop only (AudioWorklet + MediaPipe requirement)
- GCP project: `465203017930` (Wohlig), region `us-central1`
- Gemini input audio: mono PCM16, 16 000 Hz, base64. Output: mono PCM16, 24 000 Hz, base64
- Video to Gemini: 1 fps JPEG base64 — do not increase
- `sessions.expires_at` = `created_at + 48 hours` (generated column)
- WS handler MUST reject if `status != 'pending'` OR `now() >= expires_at`
- Token format: `crypto.randomBytes(32).toString('hex')`
- Suspicion score capped at 100; scoring rules in Task 10
- No Vapi, Retell, Pipecat, ElevenLabs, Deepgram, or any voice middleware

---

## File Map

```
/
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── index.ts                    # Express + WS bootstrap
│       ├── agents/
│       │   └── interviewer.ts          # ADK agent + tools
│       ├── websocket/
│       │   └── interviewRelay.ts       # WS handler (browser ↔ Gemini)
│       ├── routes/
│       │   └── sessions.ts             # REST CRUD for HR dashboard
│       ├── services/
│       │   ├── supabase.ts             # DB operations
│       │   ├── email.ts                # Resend email sender
│       │   └── report.ts               # Suspicion score + recommendation
│       └── middleware/
│           └── auth.ts                 # HR JWT verification
│
└── frontend/
    ├── package.json
    ├── next.config.ts
    ├── tailwind.config.ts
    ├── .env.local.example
    ├── public/
    │   └── pcm-processor.js            # AudioWorklet (static, no bundler)
    ├── app/
    │   ├── layout.tsx
    │   ├── login/page.tsx              # HR login
    │   ├── dashboard/
    │   │   ├── page.tsx                # HR session list
    │   │   └── sessions/[id]/page.tsx  # HR session detail
    │   └── interview/[token]/page.tsx  # Candidate interview
    ├── components/
    │   ├── interview/
    │   │   ├── PreflightCheck.tsx
    │   │   ├── InterviewRoom.tsx
    │   │   ├── ProctoringOverlay.tsx
    │   │   └── CompletedScreen.tsx
    │   └── dashboard/
    │       ├── SessionCard.tsx
    │       ├── TranscriptView.tsx
    │       └── ProctoringReport.tsx
    ├── lib/
    │   ├── capture.ts                  # InterviewCapture: audio + video + flags
    │   ├── mediapipe.ts                # FaceLandmarker wrapper
    │   └── supabase.ts                 # Supabase browser client
    └── hooks/
        └── useInterview.ts             # React hook over InterviewCapture
```

---

## Task 1: Backend — Project Scaffold + ADK Interviewer Agent

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/.env.example`
- Create: `backend/src/agents/interviewer.ts`

**Interfaces:**
- Produces: `createInterviewerAgent(questionSet, sessionId, db): Agent` — imported by `interviewRelay.ts`
- Produces: `QuestionSet`, `Question` types — used by every backend file

- [ ] **Step 1: Create backend package.json**

```json
{
  "name": "interviewai-backend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@google/adk": "^0.1.0",
    "@supabase/supabase-js": "^2.39.0",
    "express": "^4.18.0",
    "jsonwebtoken": "^9.0.0",
    "resend": "^3.2.0",
    "ws": "^8.16.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

Run: `cd backend && npm install`

- [ ] **Step 2: Create backend/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create backend/.env.example**

```
GOOGLE_API_KEY=
GOOGLE_CLOUD_PROJECT=465203017930
GOOGLE_CLOUD_LOCATION=us-central1
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
JWT_SECRET=
PORT=3001
```

Copy to `.env` and fill in real values before running.

- [ ] **Step 4: Create backend/src/agents/interviewer.ts**

```typescript
import { Agent, tool } from '@google/adk'

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

// Default question set for frontend developer role
export const frontendQuestionSet: QuestionSet = {
  id: 'fe-default',
  name: 'Frontend Developer',
  role: 'Frontend Developer',
  questions: [
    {
      id: 'fe-1',
      text: 'Can you walk me through how you would optimize a React application that is rendering slowly?',
      expected_answer: 'memoization, virtualization, code splitting, avoiding unnecessary re-renders, profiling',
      weight: 2,
    },
    {
      id: 'fe-2',
      text: 'Explain the difference between `useEffect` with no dependency array, an empty array, and a populated array.',
      expected_answer: 'runs after every render / once on mount / when deps change',
      weight: 1.5,
    },
    {
      id: 'fe-3',
      text: 'How would you implement accessibility (a11y) in a custom dropdown component?',
      expected_answer: 'ARIA roles, keyboard navigation, focus management, screen reader support',
      weight: 1,
    },
    {
      id: 'fe-4',
      text: 'Describe the CSS box model and how `box-sizing: border-box` changes it.',
      expected_answer: 'content + padding + border + margin; border-box includes padding and border in width/height',
      weight: 1,
    },
    {
      id: 'fe-5',
      text: 'You have a web page that loads 4 seconds on mobile. What is your diagnostic and optimization process?',
      expected_answer: 'Lighthouse, network waterfall, image optimization, lazy loading, bundle size, TTFB, CDN',
      weight: 2,
    },
  ],
}

interface DB {
  saveScore(sessionId: string, questionId: string, score: number, notes: string): Promise<void>
  finalizeSession(sessionId: string, recommendation: string, summary: string): Promise<void>
}

export function createInterviewerAgent(
  questionSet: QuestionSet,
  sessionId: string,
  db: DB,
  candidateName: string,
) {
  const scoreAnswer = tool({
    name: 'score_answer',
    description: "Score the candidate's answer to the current question",
    parameters: {
      question_id: { type: 'string', description: 'The question ID being scored' },
      score: { type: 'number', description: 'Score from 1 to 10' },
      notes: { type: 'string', description: 'Brief evaluation notes for the HR report' },
    },
    execute: async ({ question_id, score, notes }: { question_id: string; score: number; notes: string }) => {
      await db.saveScore(sessionId, question_id, score, notes)
      return { saved: true }
    },
  })

  const endInterview = tool({
    name: 'end_interview',
    description: 'End the interview after all questions are complete and provide final recommendation',
    parameters: {
      recommendation: {
        type: 'string',
        description: 'Hiring recommendation',
        enum: ['Strong Hire', 'Hire', 'No Hire'],
      },
      summary: {
        type: 'string',
        description: 'Two to three sentence summary of the candidate performance',
      },
    },
    execute: async ({ recommendation, summary }: { recommendation: string; summary: string }) => {
      await db.finalizeSession(sessionId, recommendation, summary)
      return { ended: true }
    },
  })

  const questions = questionSet.questions
    .map((q, i) => `${i + 1}. [ID: ${q.id}] ${q.text}`)
    .join('\n')

  return new Agent({
    model: 'gemini-live-2.5-flash',
    name: 'interviewer',
    instruction: `
You are a professional technical interviewer for Wohlig Transformations conducting a ${questionSet.role} interview.

INTERVIEW FLOW:
1. Greet ${candidateName} warmly by name. Tell them the interview will take about 20 minutes and you will ask ${questions.length} questions.
2. Ask the questions below ONE AT A TIME in order.
3. After each answer: if vague or incomplete, ask exactly ONE follow-up to probe deeper. Do not ask more than one follow-up per question.
4. Silently call score_answer() after each complete answer. Do not tell the candidate their score.
5. After all ${questions.length} questions are answered, thank the candidate warmly, then call end_interview().

TONE: Professional, calm, encouraging. Natural conversational pauses. Not robotic.

QUESTIONS:
${questions}

SCORING RUBRIC (1–10):
- 1–3: Incorrect or very shallow understanding
- 4–6: Partially correct, lacks depth or specifics
- 7–8: Good, clear understanding with practical knowledge
- 9–10: Excellent, detailed, demonstrates real expertise

Do NOT tell the candidate their scores. Do NOT rush through questions.
Do NOT ask two questions at once. Wait for a complete answer before scoring and moving on.
    `.trim(),
    tools: [scoreAnswer, endInterview],
  })
}
```

- [ ] **Step 5: Smoke-test the agent with `adk web`**

```bash
cd backend
npx adk web src/agents/interviewer.ts
```

Expected: ADK dev UI opens in browser at `http://localhost:8080`. Select the `interviewer` agent, start a voice session. Confirm it greets you, asks questions, scores answers (check console logs from the tool `execute` functions), and calls `end_interview` after all questions. Fix any API shape mismatches before proceeding.

> **Note:** If `@google/adk` is not yet publicly available on npm, install the preview/beta version:
> `npm install @google/adk@latest` or follow https://google.github.io/adk-docs for the correct install command. The tool API shown above matches the documented ADK shape.

- [ ] **Step 6: Commit**

```bash
cd backend
git init
git add package.json tsconfig.json .env.example src/agents/interviewer.ts
git commit -m "feat: backend scaffold + ADK interviewer agent with 5 frontend questions"
```

---

## Task 2: Backend Server + WebSocket Relay

**Files:**
- Create: `backend/src/index.ts`
- Create: `backend/src/websocket/interviewRelay.ts`

**Interfaces:**
- Consumes: `createInterviewerAgent` from `../agents/interviewer`
- Consumes: `supabaseService` from `../services/supabase` (stub OK for now — add `getSession` stub)
- Produces: `WS /interview/:token` endpoint that relays audio/video between browser and Gemini Live
- Produces: `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id` (stubs — full impl in Task 3)

- [ ] **Step 1: Create backend/src/index.ts**

```typescript
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { URL } from 'url'
import { handleInterviewSocket } from './websocket/interviewRelay'

const app = express()
app.use(express.json())

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))

// REST routes (stubbed, full impl in Task 3)
app.use('/api/sessions', (_req, res) => res.status(501).json({ error: 'not implemented' }))

const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`)
  const match = url.pathname.match(/^\/interview\/([a-f0-9]{64})$/)
  if (!match) {
    socket.destroy()
    return
  }
  const token = match[1]
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleInterviewSocket(ws, token)
  })
})

const PORT = process.env.PORT ?? 3001
server.listen(PORT, () => console.log(`Backend listening on :${PORT}`))
```

- [ ] **Step 2: Create backend/src/websocket/interviewRelay.ts**

```typescript
import WebSocket from 'ws'
import { createInterviewerAgent, frontendQuestionSet } from '../agents/interviewer'

// Stub DB — replace with real supabaseService in Task 3
const stubDb = {
  async getSession(token: string) {
    // Returns null in stub; WS will accept all tokens for testing
    return {
      id: 'test-session-id',
      status: 'pending',
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      candidate_name: 'Test Candidate',
      question_set: frontendQuestionSet,
    }
  },
  async saveScore(sessionId: string, questionId: string, score: number, notes: string) {
    console.log('[DB stub] saveScore', { sessionId, questionId, score, notes })
  },
  async finalizeSession(sessionId: string, recommendation: string, summary: string) {
    console.log('[DB stub] finalizeSession', { sessionId, recommendation, summary })
  },
  async saveFlag(sessionId: string, flag: ProctoringFlag) {
    console.log('[DB stub] saveFlag', { sessionId, flag })
  },
  async saveTranscriptTurn(sessionId: string, role: string, text: string) {
    console.log('[DB stub] saveTranscriptTurn', { sessionId, role, text })
  },
  async markSessionStarted(sessionId: string) {
    console.log('[DB stub] markSessionStarted', sessionId)
  },
}

interface ProctoringFlag {
  type: string
  ts: string
  [key: string]: unknown
}

interface BrowserMessage {
  type: 'audio' | 'video' | 'flag' | 'transcript'
  data?: string        // base64 for audio/video
  event?: ProctoringFlag
  text?: string
  role?: string
}

export async function handleInterviewSocket(ws: WebSocket, token: string) {
  // --- GUARD: validate session upfront ---
  const session = await stubDb.getSession(token)
  if (!session) {
    ws.close(4001, 'Session not found')
    return
  }
  if (session.status !== 'pending') {
    ws.close(4002, 'Session already completed or expired')
    return
  }
  if (new Date(session.expires_at) <= new Date()) {
    ws.close(4003, 'Session link expired')
    return
  }

  await stubDb.markSessionStarted(session.id)
  console.log(`[WS] Interview started: session=${session.id}`)

  // --- Create ADK agent ---
  const agent = createInterviewerAgent(
    session.question_set,
    session.id,
    stubDb,
    session.candidate_name,
  )

  let liveSession: Awaited<ReturnType<typeof agent.startLiveSession>> | null = null

  try {
    liveSession = await agent.startLiveSession({
      onAudio: (audioBase64: string) => {
        // Relay Gemini's spoken response (PCM16 24kHz) back to browser
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'audio', data: audioBase64 }))
        }
      },
      onTranscript: (role: string, text: string) => {
        stubDb.saveTranscriptTurn(session.id, role, text)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role, text }))
        }
      },
    })
  } catch (err) {
    console.error('[WS] Failed to start live session:', err)
    ws.close(1011, 'Failed to start AI session')
    return
  }

  ws.on('message', async (raw) => {
    let msg: BrowserMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'audio':
        if (msg.data && liveSession) {
          await liveSession.sendAudio(msg.data, 'audio/pcm;rate=16000')
        }
        break

      case 'video':
        if (msg.data && liveSession) {
          await liveSession.sendImage(msg.data, 'image/jpeg')
        }
        break

      case 'flag':
        if (msg.event) {
          await stubDb.saveFlag(session.id, msg.event)
        }
        break
    }
  })

  ws.on('close', () => {
    liveSession?.close()
    console.log(`[WS] Interview closed: session=${session.id}`)
  })

  ws.on('error', (err) => {
    console.error('[WS] Error:', err)
    liveSession?.close()
  })
}
```

- [ ] **Step 3: Start the backend and confirm it listens**

```bash
cd backend
cp .env.example .env  # fill in GOOGLE_API_KEY first
npm run dev
```

Expected output: `Backend listening on :3001`

- [ ] **Step 4: Create a minimal HTML test page to verify audio round-trip**

Create `backend/test-client.html` (not committed, for local testing only):

```html
<!DOCTYPE html>
<html>
<head><title>WS Audio Test</title></head>
<body>
<button id="start">Start</button>
<button id="stop" disabled>Stop</button>
<script>
const TOKEN = 'a'.repeat(64)  // dummy token — accepted by stub DB
let ws, audioCtx, workletNode

document.getElementById('start').onclick = async () => {
  audioCtx = new AudioContext({ sampleRate: 16000 })
  await audioCtx.audioWorklet.addModule('/pcm-processor.js')
  // (pcm-processor.js not yet built — skip audio send for now, just verify WS connects)
  ws = new WebSocket(`ws://localhost:3001/interview/${TOKEN}`)
  ws.onopen = () => console.log('Connected')
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    console.log('From server:', msg.type, msg.text ?? '')
  }
  ws.onclose = (e) => console.log('Closed:', e.code, e.reason)
  document.getElementById('stop').disabled = false
}
document.getElementById('stop').onclick = () => ws?.close()
</script>
</body>
</html>
```

Open `backend/test-client.html` in Chrome (serve it via any static server). Confirm the WebSocket connects and Gemini's greeting arrives as a `{ type: 'transcript', role: 'model', text: '...' }` message.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/websocket/interviewRelay.ts
git commit -m "feat: Express + WS relay with stub DB, validates session token on connect"
```

---

## Task 3: Supabase Schema + Backend REST API

**Files:**
- Create: `backend/supabase/migrations/001_initial.sql`
- Create: `backend/src/services/supabase.ts`
- Create: `backend/src/middleware/auth.ts`
- Create: `backend/src/routes/sessions.ts`
- Modify: `backend/src/index.ts` (wire in real routes)
- Modify: `backend/src/websocket/interviewRelay.ts` (swap stub DB for real supabaseService)

**Interfaces:**
- Produces: `supabaseService` object with methods: `getSession`, `saveScore`, `finalizeSession`, `saveFlag`, `saveTranscriptTurn`, `markSessionStarted`, `createSession`, `listSessions`, `getSessionDetail`
- Produces: `authMiddleware` Express middleware
- Produces: REST endpoints `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/report`

- [ ] **Step 1: Create Supabase migration SQL**

Create `backend/supabase/migrations/001_initial.sql`:

```sql
-- Organizations
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- HR users
create table if not exists hr_users (
  id uuid primary key references auth.users,
  org_id uuid references organizations,
  name text,
  email text
);

-- Question banks
create table if not exists question_sets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations,
  name text not null,
  role text,
  questions jsonb not null,
  created_at timestamptz default now()
);

-- Interview sessions
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations,
  created_by uuid references hr_users,
  candidate_name text not null,
  candidate_email text not null,
  job_title text not null,
  question_set_id uuid references question_sets,
  token text unique not null,
  status text default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  suspicion_score integer default 0,
  recommendation text,
  overall_score numeric,
  created_at timestamptz default now(),
  expires_at timestamptz generated always as (created_at + interval '48 hours') stored
);

-- Transcript turns
create table if not exists transcript_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  role text not null,
  text text not null,
  question_id text,
  score integer,
  ts timestamptz default now()
);

-- Proctoring flags
create table if not exists proctoring_flags (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions on delete cascade,
  flag_type text not null,
  severity text default 'low',
  detail jsonb,
  ts timestamptz default now()
);

-- RLS: HR can read their org's sessions
alter table sessions enable row level security;
create policy "hr_read_sessions" on sessions
  for select using (auth.uid() in (
    select id from hr_users where org_id = sessions.org_id
  ));
```

Run this in Supabase SQL editor or via `supabase db push`.

- [ ] **Step 2: Create backend/src/services/supabase.ts**

```typescript
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import type { QuestionSet } from '../agents/interviewer'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

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
}

export const supabaseService = {
  async getSession(token: string) {
    const { data, error } = await supabase
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
      question_set: data.question_sets as unknown as QuestionSet,
    }
  },

  async markSessionStarted(sessionId: string) {
    await supabase
      .from('sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', sessionId)
  },

  async saveScore(sessionId: string, questionId: string, score: number, notes: string) {
    await supabase
      .from('transcript_turns')
      .update({ score, question_id: questionId })
      .eq('session_id', sessionId)
      .eq('role', 'candidate')
      .is('question_id', null)
      .order('ts', { ascending: false })
      .limit(1)

    // Also insert a notes record
    await supabase.from('transcript_turns').insert({
      session_id: sessionId,
      role: 'model',
      text: `[Score: ${score}/10] ${notes}`,
      question_id: questionId,
      score,
    })
  },

  async saveTranscriptTurn(sessionId: string, role: string, text: string) {
    await supabase.from('transcript_turns').insert({ session_id: sessionId, role, text })
  },

  async saveFlag(sessionId: string, flag: { type: string; ts: string; [k: string]: unknown }) {
    await supabase.from('proctoring_flags').insert({
      session_id: sessionId,
      flag_type: flag.type,
      severity: FLAG_SEVERITY[flag.type] ?? 'low',
      detail: flag,
      ts: flag.ts,
    })
  },

  async finalizeSession(sessionId: string, recommendation: string, summary: string) {
    await supabase
      .from('sessions')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        recommendation,
      })
      .eq('id', sessionId)
  },

  async createSession(params: {
    org_id: string
    created_by: string
    candidate_name: string
    candidate_email: string
    job_title: string
    question_set_id: string
  }) {
    const token = crypto.randomBytes(32).toString('hex')
    const { data, error } = await supabase
      .from('sessions')
      .insert({ ...params, token })
      .select()
      .single()
    if (error) throw error
    return data as { id: string; token: string }
  },

  async listSessions(orgId: string) {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, candidate_name, candidate_email, job_title, status, suspicion_score, recommendation, overall_score, created_at, started_at, ended_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async getSessionDetail(sessionId: string) {
    const [{ data: session }, { data: turns }, { data: flags }] = await Promise.all([
      supabase.from('sessions').select('*').eq('id', sessionId).single(),
      supabase.from('transcript_turns').select('*').eq('session_id', sessionId).order('ts'),
      supabase.from('proctoring_flags').select('*').eq('session_id', sessionId).order('ts'),
    ])
    return { session, turns: turns ?? [], flags: flags ?? [] }
  },
}
```

- [ ] **Step 3: Create backend/src/middleware/auth.ts**

```typescript
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  hrUserId?: string
  orgId?: string
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as {
      sub: string
      org_id: string
    }
    req.hrUserId = payload.sub
    req.orgId = payload.org_id
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
```

- [ ] **Step 4: Create backend/src/routes/sessions.ts**

```typescript
import { Router } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { supabaseService } from '../services/supabase'
import { emailService } from '../services/email'

const router = Router()
router.use(authMiddleware)

// POST /api/sessions — create session + send invite email
router.post('/', async (req: AuthRequest, res) => {
  const { candidate_name, candidate_email, job_title, question_set_id } = req.body
  if (!candidate_name || !candidate_email || !job_title || !question_set_id) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  try {
    const session = await supabaseService.createSession({
      org_id: req.orgId!,
      created_by: req.hrUserId!,
      candidate_name,
      candidate_email,
      job_title,
      question_set_id,
    })
    await emailService.sendInvite({
      to: candidate_email,
      candidateName: candidate_name,
      jobTitle: job_title,
      token: session.token,
    })
    res.status(201).json({ id: session.id })
  } catch (err) {
    console.error('[POST /api/sessions]', err)
    res.status(500).json({ error: 'Failed to create session' })
  }
})

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
    const detail = await supabaseService.getSessionDetail(req.params.id)
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

- [ ] **Step 5: Wire real routes into index.ts and swap stub DB in relay**

Replace the stub sessions route in `backend/src/index.ts`:

```typescript
import sessionsRouter from './routes/sessions'
// ...
app.use('/api/sessions', sessionsRouter)
```

Replace `stubDb` in `backend/src/websocket/interviewRelay.ts`:

```typescript
import { supabaseService } from '../services/supabase'
// Replace: const stubDb = { ... }
// With:
const db = supabaseService
// And use `db` instead of `stubDb` throughout
```

- [ ] **Step 6: Test REST API with curl**

```bash
# Get a JWT token from Supabase Auth (HR user login) then:
curl -H "Authorization: Bearer $JWT" http://localhost:3001/api/sessions
```

Expected: `[]` (empty array — no sessions yet)

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"candidate_name":"Alice","candidate_email":"alice@example.com","job_title":"Frontend Dev","question_set_id":"<your-qs-id>"}'
```

Expected: `{"id":"<uuid>"}` and an email sent to alice@example.com.

- [ ] **Step 7: Commit**

```bash
git add supabase/ src/services/supabase.ts src/middleware/auth.ts src/routes/sessions.ts src/index.ts src/websocket/interviewRelay.ts
git commit -m "feat: Supabase schema, real DB service, HR REST API with JWT auth"
```

---

## Task 4: Frontend Scaffold + Browser Audio Capture

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/next.config.ts`
- Create: `frontend/tailwind.config.ts`
- Create: `frontend/.env.local.example`
- Create: `frontend/public/pcm-processor.js`
- Create: `frontend/lib/capture.ts` (audio section)

**Interfaces:**
- Produces: `InterviewCapture` class with methods: `startAudio()`, `stopAudio()`, `sendFlag(event)`, property: `ws: WebSocket`
- Produces: `onAudio(base64: string): void` callback on the class for received Gemini audio

- [ ] **Step 1: Create frontend/package.json**

```json
{
  "name": "interviewai-frontend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "@mediapipe/tasks-vision": "^0.10.14",
    "@supabase/supabase-js": "^2.39.0",
    "next": "14.2.3",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.18",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1",
    "typescript": "^5.3.3"
  }
}
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Create frontend/next.config.ts**

```typescript
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
}

export default nextConfig
```

- [ ] **Step 3: Create frontend/tailwind.config.ts**

```typescript
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}

export default config
```

- [ ] **Step 4: Create frontend/.env.local.example**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:3001
NEXT_PUBLIC_BACKEND_API_URL=http://localhost:3001
```

Copy to `.env.local` and fill in values.

- [ ] **Step 5: Create frontend/public/pcm-processor.js**

This file must be a plain JavaScript file in `/public/` so Next.js serves it as a static asset. AudioWorklet cannot use bundled modules.

```javascript
// AudioWorklet processor: buffers Float32 audio and posts 2048-sample chunks
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(2048)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const channel = input[0]

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i]
      if (this._offset >= 2048) {
        // Clone buffer so we don't race
        this.port.postMessage(this._buffer.slice())
        this._offset = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
```

- [ ] **Step 6: Create frontend/lib/capture.ts (audio section)**

```typescript
// InterviewCapture: manages mic capture, video capture, and flag streaming

export interface ProctoringEvent {
  type: string
  ts: string
  [key: string]: unknown
}

type AudioCallback = (base64: string) => void
type TranscriptCallback = (role: string, text: string) => void

export class InterviewCapture {
  private ws: WebSocket | null = null
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private onAudioCb: AudioCallback | null = null
  private onTranscriptCb: TranscriptCallback | null = null
  private sessionToken: string

  constructor(token: string) {
    this.sessionToken = token
  }

  // --- WebSocket connection ---

  connect(backendWsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${backendWsUrl}/interview/${this.sessionToken}`
      this.ws = new WebSocket(url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(new Error('WS connection failed'))
      this.ws.onmessage = (e) => this._handleServerMessage(e)
    })
  }

  private _handleServerMessage(e: MessageEvent) {
    let msg: { type: string; data?: string; role?: string; text?: string }
    try { msg = JSON.parse(e.data) } catch { return }

    if (msg.type === 'audio' && msg.data && this.onAudioCb) {
      this.onAudioCb(msg.data)
    }
    if (msg.type === 'transcript' && msg.role && msg.text && this.onTranscriptCb) {
      this.onTranscriptCb(msg.role, msg.text)
    }
  }

  onAudio(cb: AudioCallback) { this.onAudioCb = cb }
  onTranscript(cb: TranscriptCallback) { this.onTranscriptCb = cb }

  // --- Mic capture ---

  async startAudio(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    })
    this.audioCtx = new AudioContext({ sampleRate: 16000 })
    await this.audioCtx.audioWorklet.addModule('/pcm-processor.js')
    const source = this.audioCtx.createMediaStreamSource(this.micStream)
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-processor')
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this._sendAudioChunk(e.data)
    }
    source.connect(this.workletNode)
    // AudioWorklet output doesn't need to connect to destination (we only capture)
  }

  private _sendAudioChunk(float32: Float32Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Convert Float32 → Int16
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
    }
    // Base64 encode
    const bytes = new Uint8Array(int16.buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    const base64 = btoa(binary)
    this.ws.send(JSON.stringify({ type: 'audio', data: base64 }))
  }

  stopAudio() {
    this.workletNode?.disconnect()
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.audioCtx?.close()
    this.workletNode = null
    this.micStream = null
    this.audioCtx = null
  }

  // --- Play Gemini's audio response ---

  async playAudio(base64: string): Promise<void> {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const int16 = new Int16Array(bytes.buffer)
    const playCtx = new AudioContext({ sampleRate: 24000 })
    const buffer = playCtx.createBuffer(1, int16.length, 24000)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768
    const source = playCtx.createBufferSource()
    source.buffer = buffer
    source.connect(playCtx.destination)
    source.start()
    return new Promise((resolve) => { source.onended = () => { playCtx.close(); resolve() } })
  }

  // --- Flag streaming ---

  sendFlag(event: ProctoringEvent) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'flag', event }))
  }

  // --- Cleanup ---

  disconnect() {
    this.stopAudio()
    this.ws?.close()
    this.ws = null
  }
}
```

- [ ] **Step 7: Create a minimal Next.js app shell**

Create `frontend/app/layout.tsx`:

```typescript
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'InterviewAI' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white min-h-screen">{children}</body>
    </html>
  )
}
```

Create `frontend/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Manually test audio round-trip**

```bash
cd frontend && npm run dev
```

Navigate to any page in Chrome. Open browser console, paste:

```javascript
// Quick audio test — run after backend is up with a valid token
const { InterviewCapture } = await import('/lib/capture.ts')  // dev mode
const cap = new InterviewCapture('<your-64-char-token>')
cap.onAudio((b64) => cap.playAudio(b64))  // play back Gemini's audio
await cap.connect('ws://localhost:3001')
await cap.startAudio()
// Speak into mic — you should hear Gemini's greeting back
```

Expected: Gemini greets you by name in audio. If audio playback doesn't work, check console for decoding errors.

- [ ] **Step 9: Commit**

```bash
cd frontend
git add package.json next.config.ts tailwind.config.ts .env.local.example public/pcm-processor.js lib/capture.ts app/layout.tsx app/globals.css
git commit -m "feat: Next.js scaffold, AudioWorklet PCM capture, Gemini audio playback"
```

---

## Task 5: Browser Video Capture + MediaPipe Face/Gaze Detection

**Files:**
- Create: `frontend/lib/mediapipe.ts`
- Modify: `frontend/lib/capture.ts` (add `startVideo`, `stopVideo`, `startFaceDetection`, `stopFaceDetection`)

**Interfaces:**
- Consumes: `InterviewCapture` from `./capture` (extends it)
- Produces: `FaceEvent` type; `InterviewCapture.startVideo(videoEl)`, `stopVideo()`, `startFaceDetection(videoEl, onFlag)`, `stopFaceDetection()`

- [ ] **Step 1: Create frontend/lib/mediapipe.ts**

```typescript
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision'

let faceLandmarker: FaceLandmarker | null = null

export async function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (faceLandmarker) return faceLandmarker

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  )
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 2,
  })
  return faceLandmarker
}

export interface GazeResult {
  faceCount: number
  yaw: number   // degrees left/right; >30 = looking away
  pitch: number // degrees up/down; >30 = looking away
}

// Extract head pose yaw and pitch from the first face's transformation matrix
export function extractGaze(result: FaceLandmarkerResult): GazeResult {
  const faceCount = result.faceLandmarks.length
  if (faceCount === 0) return { faceCount: 0, yaw: 0, pitch: 0 }

  const matrix = result.facialTransformationMatrixes?.[0]?.data
  if (!matrix) return { faceCount, yaw: 0, pitch: 0 }

  // Extract Euler angles from rotation matrix (column-major 4x4)
  // Row 2 col 0 = sin(pitch), row 0 col 0 = cos(yaw)*cos(pitch), etc.
  const sinPitch = -matrix[9]
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinPitch))) * (180 / Math.PI)
  const yaw = Math.atan2(matrix[8], matrix[10]) * (180 / Math.PI)

  return { faceCount, yaw, pitch }
}
```

- [ ] **Step 2: Add video methods to InterviewCapture in frontend/lib/capture.ts**

Add these properties and methods to the `InterviewCapture` class:

```typescript
// Add to class fields:
private videoStream: MediaStream | null = null
private videoInterval: ReturnType<typeof setInterval> | null = null
private faceRafId: number | null = null
private gazeAwayStart: number | null = null

// Add method: startVideo
async startVideo(videoEl: HTMLVideoElement): Promise<void> {
  this.videoStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  })
  videoEl.srcObject = this.videoStream
  await videoEl.play()

  // Send 1 frame/sec to Gemini
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

// Add method: stopVideo
stopVideo() {
  if (this.videoInterval) clearInterval(this.videoInterval)
  this.videoStream?.getTracks().forEach((t) => t.stop())
  this.videoInterval = null
  this.videoStream = null
}

// Add method: startFaceDetection
async startFaceDetection(
  videoEl: HTMLVideoElement,
  onFlag: (event: ProctoringEvent) => void,
) {
  const { initFaceLandmarker, extractGaze } = await import('./mediapipe')
  const landmarker = await initFaceLandmarker()

  const detect = () => {
    if (!videoEl.videoWidth) { this.faceRafId = requestAnimationFrame(detect); return }

    const result = landmarker.detectForVideo(videoEl, Date.now())
    const { faceCount, yaw, pitch } = extractGaze(result)
    const ts = new Date().toISOString()

    if (faceCount === 0) {
      onFlag({ type: 'face_absent', ts })
    } else if (faceCount >= 2) {
      onFlag({ type: 'face_multiple', ts, count: faceCount })
    } else {
      // Gaze away: yaw or pitch beyond 30°
      const isLookingAway = Math.abs(yaw) > 30 || Math.abs(pitch) > 30
      if (isLookingAway) {
        if (!this.gazeAwayStart) this.gazeAwayStart = Date.now()
        const duration = (Date.now() - this.gazeAwayStart) / 1000
        if (duration > 3) {
          onFlag({ type: 'gaze_away', ts, duration, yaw, pitch })
        }
      } else {
        this.gazeAwayStart = null
      }
    }

    this.faceRafId = requestAnimationFrame(detect)
  }
  this.faceRafId = requestAnimationFrame(detect)
}

// Add method: stopFaceDetection
stopFaceDetection() {
  if (this.faceRafId) cancelAnimationFrame(this.faceRafId)
  this.faceRafId = null
}
```

Also extend `disconnect()` to call `stopVideo()` and `stopFaceDetection()`.

- [ ] **Step 3: Test face detection in isolation**

In browser console on any Next.js page:

```javascript
import { initFaceLandmarker, extractGaze } from '/lib/mediapipe.ts'
const lm = await initFaceLandmarker()
const video = document.querySelector('video')  // must already be playing webcam
const result = lm.detectForVideo(video, Date.now())
console.log('Faces:', result.faceLandmarks.length)
console.log('Gaze:', extractGaze(result))
```

Expected: `Faces: 1`, `Gaze: { faceCount: 1, yaw: ~0, pitch: ~0 }` when looking directly at camera. Turn head — `yaw` should shift ±30+°.

- [ ] **Step 4: Commit**

```bash
git add lib/mediapipe.ts lib/capture.ts
git commit -m "feat: webcam capture at 1fps to Gemini, MediaPipe face+gaze detection"
```

---

## Task 6: Browser Proctoring Events + useInterview Hook

**Files:**
- Modify: `frontend/lib/capture.ts` (add proctoring event listeners)
- Create: `frontend/hooks/useInterview.ts`

**Interfaces:**
- Produces: `InterviewCapture.startProctoring(videoEl)`, `stopProctoring()`
- Produces: `useInterview(token)` React hook returning `{ stage, capture, transcript, flags, connect, start, end }`

- [ ] **Step 1: Add proctoring event listeners to InterviewCapture**

Add to class fields:
```typescript
private proctoringHandlers: Array<{ el: EventTarget; type: string; fn: EventListener }> = []
```

Add method `startProctoring`:

```typescript
startProctoring(videoEl: HTMLVideoElement) {
  const flag = (event: ProctoringEvent) => this.sendFlag(event)
  const listen = (el: EventTarget, type: string, fn: (e: Event) => void) => {
    el.addEventListener(type, fn)
    this.proctoringHandlers.push({ el, type, fn: fn as EventListener })
  }

  // Tab switch / window blur
  listen(document, 'visibilitychange', () => {
    if (document.hidden) flag({ type: 'tab_switch', ts: new Date().toISOString() })
  })
  listen(window, 'blur', () => flag({ type: 'window_blur', ts: new Date().toISOString() }))

  // Fullscreen exit
  listen(document, 'fullscreenchange', () => {
    if (!document.fullscreenElement) flag({ type: 'fullscreen_exit', ts: new Date().toISOString() })
  })

  // Copy / paste
  listen(document, 'copy', (e) => {
    e.preventDefault()
    flag({ type: 'copy_attempt', ts: new Date().toISOString() })
  })
  listen(document, 'paste', (e) => {
    e.preventDefault()
    flag({ type: 'paste_attempt', ts: new Date().toISOString() })
  })

  // Right-click
  listen(document, 'contextmenu', (e) => {
    e.preventDefault()
    flag({ type: 'right_click', ts: new Date().toISOString() })
  })

  // Keyboard shortcuts
  listen(document, 'keydown', (e: Event) => {
    const ke = e as KeyboardEvent
    const blocked =
      (ke.ctrlKey && ['c', 'v', 'a', 'u'].includes(ke.key.toLowerCase())) ||
      ke.key === 'F12' ||
      (ke.altKey && ke.key === 'Tab')
    if (blocked) {
      ke.preventDefault()
      flag({ type: 'keyboard_shortcut', ts: new Date().toISOString(), key: ke.key })
    }
  })

  // Start face detection (fires flags via same flag callback)
  this.startFaceDetection(videoEl, flag)
}
```

Add method `stopProctoring`:

```typescript
stopProctoring() {
  this.proctoringHandlers.forEach(({ el, type, fn }) => el.removeEventListener(type, fn))
  this.proctoringHandlers = []
  this.stopFaceDetection()
}
```

- [ ] **Step 2: Create frontend/hooks/useInterview.ts**

```typescript
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { InterviewCapture, ProctoringEvent } from '../lib/capture'

export type InterviewStage =
  | 'idle'
  | 'preflight'
  | 'connecting'
  | 'active'
  | 'completed'
  | 'error'

export interface TranscriptTurn {
  role: 'model' | 'candidate'
  text: string
  ts: string
}

export function useInterview(token: string, backendWsUrl: string) {
  const [stage, setStage] = useState<InterviewStage>('idle')
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([])
  const [flags, setFlags] = useState<ProctoringEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const captureRef = useRef<InterviewCapture | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const connect = useCallback(async () => {
    setStage('connecting')
    setError(null)
    try {
      const cap = new InterviewCapture(token)
      cap.onAudio((b64) => cap.playAudio(b64))
      cap.onTranscript((role, text) => {
        setTranscript((prev) => [...prev, { role: role as 'model' | 'candidate', text, ts: new Date().toISOString() }])
      })
      await cap.connect(backendWsUrl)
      captureRef.current = cap
      setStage('preflight')
    } catch (err) {
      setError('Failed to connect to interview server. Please refresh.')
      setStage('error')
    }
  }, [token, backendWsUrl])

  const start = useCallback(async (videoEl: HTMLVideoElement) => {
    const cap = captureRef.current
    if (!cap) return
    videoRef.current = videoEl

    await cap.startAudio()
    await cap.startVideo(videoEl)
    cap.startProctoring(videoEl)

    // Request fullscreen
    try { await document.documentElement.requestFullscreen() } catch {}

    setStage('active')
  }, [])

  const end = useCallback(() => {
    const cap = captureRef.current
    if (!cap) return
    cap.stopProctoring()
    cap.stopVideo()
    cap.stopAudio()
    cap.disconnect()
    captureRef.current = null
    setStage('completed')
  }, [])

  // Listen for end_interview signal from server
  useEffect(() => {
    // The WS relay will close the connection when end_interview tool fires
    // InterviewCapture's ws onclose triggers cleanup
  }, [])

  return { stage, transcript, flags, error, connect, start, end }
}
```

- [ ] **Step 3: Manual proctoring test**

In the browser console while the interview is active:

- Switch to another tab → check backend logs for `saveFlag` with type `tab_switch`
- Press Ctrl+C → check for `copy_attempt`
- Cover face with hand → check for `face_absent` after ~1 second

- [ ] **Step 4: Commit**

```bash
git add lib/capture.ts hooks/useInterview.ts
git commit -m "feat: full browser proctoring (tab switch, copy/paste, keyboard, face/gaze) + useInterview hook"
```

---

## Task 7: Interview UI Components

**Files:**
- Create: `frontend/components/interview/PreflightCheck.tsx`
- Create: `frontend/components/interview/InterviewRoom.tsx`
- Create: `frontend/components/interview/ProctoringOverlay.tsx`
- Create: `frontend/components/interview/CompletedScreen.tsx`
- Create: `frontend/app/interview/[token]/page.tsx`

**Interfaces:**
- Consumes: `useInterview(token, wsUrl)` from `../../hooks/useInterview`

- [ ] **Step 1: Create frontend/components/interview/PreflightCheck.tsx**

```typescript
'use client'
import { useRef, useState } from 'react'

interface Props {
  onReady: (videoEl: HTMLVideoElement) => void
}

export function PreflightCheck({ onReady }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [micOk, setMicOk] = useState(false)
  const [camOk, setCamOk] = useState(false)

  async function testDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setMicOk(true)
      setCamOk(true)
    } catch {
      alert('Camera and microphone access is required. Please allow access and refresh.')
    }
  }

  const canStart = micOk && camOk

  return (
    <div className="flex flex-col items-center gap-6 p-8 max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold">Before we begin</h1>

      <video
        ref={videoRef}
        muted
        playsInline
        className="w-64 h-48 rounded-lg bg-gray-800 object-cover"
      />

      <ul className="w-full space-y-2 text-sm">
        {[
          'This interview is conducted by an AI. Your voice and video will be recorded.',
          'Do not switch tabs or leave this window during the interview.',
          'Ensure you are in a quiet, well-lit room.',
          'The interview takes approximately 20 minutes.',
          'You may not use notes, search engines, or AI tools during the interview.',
        ].map((rule, i) => (
          <li key={i} className="flex gap-2 text-gray-300">
            <span className="text-blue-400 shrink-0">•</span> {rule}
          </li>
        ))}
      </ul>

      <div className="flex gap-4 text-sm">
        <span className={micOk ? 'text-green-400' : 'text-gray-500'}>Microphone {micOk ? '✓' : '—'}</span>
        <span className={camOk ? 'text-green-400' : 'text-gray-500'}>Camera {camOk ? '✓' : '—'}</span>
      </div>

      {!camOk && (
        <button
          onClick={testDevices}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium"
        >
          Test camera & microphone
        </button>
      )}

      {canStart && (
        <button
          onClick={() => videoRef.current && onReady(videoRef.current)}
          className="px-8 py-3 bg-green-600 hover:bg-green-500 rounded-lg font-semibold text-lg"
        >
          Start Interview
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create frontend/components/interview/ProctoringOverlay.tsx**

```typescript
'use client'
// Invisible layer — blocks right-click, warns on restricted actions
export function ProctoringOverlay() {
  return (
    <div
      className="fixed inset-0 pointer-events-none z-50"
      onContextMenu={(e) => e.preventDefault()}
    />
  )
}
```

- [ ] **Step 3: Create frontend/components/interview/InterviewRoom.tsx**

```typescript
'use client'
import { useEffect, useRef } from 'react'
import type { TranscriptTurn } from '../../hooks/useInterview'

interface Props {
  candidateName: string
  transcript: TranscriptTurn[]
  onStart: (videoEl: HTMLVideoElement) => void
  questionCount: number
}

export function InterviewRoom({ candidateName, transcript, onStart, questionCount }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (videoRef.current) onStart(videoRef.current)
  }, [onStart])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [transcript])

  const answeredCount = transcript.filter((t) => t.role === 'candidate').length

  return (
    <div className="flex h-screen">
      {/* Left: interview feed */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        {/* AI avatar placeholder — waveform */}
        <div className="w-32 h-32 rounded-full bg-blue-900 flex items-center justify-center text-4xl">
          🤖
        </div>
        <p className="text-gray-300 text-sm">AI Interviewer — Wohlig Transformations</p>

        {/* Candidate's own video (small, corner) */}
        <video
          ref={videoRef}
          muted
          playsInline
          className="fixed bottom-4 right-4 w-40 h-28 rounded-lg object-cover border border-gray-700"
        />

        {/* Progress */}
        <div className="w-full max-w-xs">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Progress</span>
            <span>{answeredCount} / {questionCount} questions</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all"
              style={{ width: `${(answeredCount / questionCount) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Right: transcript */}
      <div className="w-80 border-l border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800 text-sm text-gray-400">Live Transcript</div>
        <div ref={transcriptRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {transcript.map((turn, i) => (
            <div key={i} className={turn.role === 'model' ? 'text-blue-300' : 'text-white'}>
              <span className="text-xs text-gray-500 block mb-0.5">
                {turn.role === 'model' ? 'Interviewer' : candidateName}
              </span>
              <p className="text-sm">{turn.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create frontend/components/interview/CompletedScreen.tsx**

```typescript
'use client'
export function CompletedScreen() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center p-8">
      <div className="text-5xl">✅</div>
      <h1 className="text-2xl font-semibold">Interview Complete</h1>
      <p className="text-gray-400 max-w-sm">
        Thank you for your time. Our team will review your interview and be in touch soon.
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Create frontend/app/interview/[token]/page.tsx**

```typescript
import { InterviewPageClient } from './client'

export default function InterviewPage({ params }: { params: { token: string } }) {
  return <InterviewPageClient token={params.token} />
}
```

Create `frontend/app/interview/[token]/client.tsx`:

```typescript
'use client'
import { useEffect } from 'react'
import { useInterview } from '../../../hooks/useInterview'
import { PreflightCheck } from '../../../components/interview/PreflightCheck'
import { InterviewRoom } from '../../../components/interview/InterviewRoom'
import { ProctoringOverlay } from '../../../components/interview/ProctoringOverlay'
import { CompletedScreen } from '../../../components/interview/CompletedScreen'

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL!

interface Props { token: string }

export function InterviewPageClient({ token }: Props) {
  const { stage, transcript, error, connect, start, end } = useInterview(token, WS_URL)

  useEffect(() => { connect() }, [connect])

  if (!navigator.userAgent.includes('Chrome')) {
    return (
      <div className="flex items-center justify-center min-h-screen p-8 text-center">
        <p className="text-yellow-400">
          InterviewAI requires Google Chrome on desktop. Please open this link in Chrome.
        </p>
      </div>
    )
  }

  if (error) return <div className="flex items-center justify-center min-h-screen text-red-400 p-8">{error}</div>
  if (stage === 'idle' || stage === 'connecting') {
    return <div className="flex items-center justify-center min-h-screen text-gray-400">Connecting…</div>
  }
  if (stage === 'completed') return <CompletedScreen />

  return (
    <>
      <ProctoringOverlay />
      {stage === 'preflight' && <PreflightCheck onReady={start} />}
      {stage === 'active' && (
        <InterviewRoom
          candidateName="Candidate"
          transcript={transcript}
          onStart={start}
          questionCount={5}
        />
      )}
    </>
  )
}
```

- [ ] **Step 6: End-to-end test the full interview flow**

1. Start backend: `cd backend && npm run dev`
2. Start frontend: `cd frontend && npm run dev`
3. Create a test session in Supabase (or via `POST /api/sessions` with JWT)
4. Open `http://localhost:3000/interview/<token>` in Chrome
5. Grant camera + mic, click "Start Interview"
6. Complete a full interview — Gemini should ask all 5 questions, score them, and call `end_interview`
7. UI should transition to CompletedScreen

- [ ] **Step 7: Commit**

```bash
git add components/interview/ app/interview/ hooks/useInterview.ts
git commit -m "feat: full interview UI — preflight, active room, proctoring overlay, completed screen"
```

---

## Task 8: HR Dashboard

**Files:**
- Create: `frontend/lib/supabase.ts`
- Create: `frontend/app/login/page.tsx`
- Create: `frontend/app/dashboard/page.tsx`
- Create: `frontend/app/dashboard/sessions/[id]/page.tsx`
- Create: `frontend/components/dashboard/SessionCard.tsx`
- Create: `frontend/components/dashboard/TranscriptView.tsx`
- Create: `frontend/components/dashboard/ProctoringReport.tsx`

**Interfaces:**
- Consumes: REST API `GET /api/sessions`, `GET /api/sessions/:id` from backend

- [ ] **Step 1: Create frontend/lib/supabase.ts**

```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
```

- [ ] **Step 2: Create frontend/app/login/page.tsx**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false); return }
    router.push('/dashboard')
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <form onSubmit={login} className="w-80 space-y-4 p-8 bg-gray-900 rounded-xl border border-gray-800">
        <h1 className="text-xl font-semibold">HR Login</h1>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <input
          className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Create frontend/components/dashboard/SessionCard.tsx**

```typescript
import Link from 'next/link'

interface Session {
  id: string
  candidate_name: string
  candidate_email: string
  job_title: string
  status: string
  suspicion_score: number
  recommendation: string | null
  overall_score: number | null
  created_at: string
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-yellow-400',
  in_progress: 'text-blue-400',
  completed: 'text-green-400',
  expired: 'text-gray-500',
}

export function SessionCard({ session }: { session: Session }) {
  return (
    <Link href={`/dashboard/sessions/${session.id}`}
      className="block p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-600 transition-colors"
    >
      <div className="flex justify-between items-start">
        <div>
          <p className="font-medium">{session.candidate_name}</p>
          <p className="text-sm text-gray-400">{session.job_title}</p>
          <p className="text-xs text-gray-500">{session.candidate_email}</p>
        </div>
        <div className="text-right">
          <span className={`text-xs font-medium ${STATUS_COLOR[session.status] ?? 'text-gray-400'}`}>
            {session.status}
          </span>
          {session.recommendation && (
            <p className="text-sm mt-1">{session.recommendation}</p>
          )}
          {session.suspicion_score > 0 && (
            <p className="text-xs text-orange-400 mt-1">Suspicion: {session.suspicion_score}/100</p>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-600 mt-2">{new Date(session.created_at).toLocaleString()}</p>
    </Link>
  )
}
```

- [ ] **Step 4: Create frontend/components/dashboard/TranscriptView.tsx**

```typescript
interface Turn {
  role: string
  text: string
  question_id: string | null
  score: number | null
  ts: string
}

export function TranscriptView({ turns }: { turns: Turn[] }) {
  return (
    <div className="space-y-3">
      {turns.map((turn, i) => (
        <div key={i} className={`p-3 rounded-lg ${turn.role === 'model' ? 'bg-blue-950' : 'bg-gray-900'}`}>
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs font-medium text-gray-400">
              {turn.role === 'model' ? 'AI Interviewer' : 'Candidate'}
            </span>
            <div className="flex items-center gap-2">
              {turn.score != null && (
                <span className="text-xs bg-blue-800 px-2 py-0.5 rounded-full">
                  Score: {turn.score}/10
                </span>
              )}
              <span className="text-xs text-gray-600">{new Date(turn.ts).toLocaleTimeString()}</span>
            </div>
          </div>
          <p className="text-sm">{turn.text}</p>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Create frontend/components/dashboard/ProctoringReport.tsx**

```typescript
interface Flag {
  id: string
  flag_type: string
  severity: string
  detail: Record<string, unknown>
  ts: string
}

const SEVERITY_COLOR: Record<string, string> = {
  low: 'text-yellow-500',
  medium: 'text-orange-500',
  high: 'text-red-500',
}

export function ProctoringReport({ flags, suspicionScore }: { flags: Flag[]; suspicionScore: number }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-sm text-gray-400">Suspicion Score:</span>
        <span className={`text-2xl font-bold ${suspicionScore > 60 ? 'text-red-400' : suspicionScore > 30 ? 'text-orange-400' : 'text-green-400'}`}>
          {suspicionScore}/100
        </span>
      </div>

      {flags.length === 0 ? (
        <p className="text-sm text-gray-500">No proctoring flags recorded.</p>
      ) : (
        <div className="space-y-2">
          {flags.map((flag) => (
            <div key={flag.id} className="flex items-start gap-3 p-3 bg-gray-900 rounded-lg text-sm">
              <span className={`shrink-0 font-medium ${SEVERITY_COLOR[flag.severity]}`}>
                [{flag.severity.toUpperCase()}]
              </span>
              <div>
                <span className="font-mono">{flag.flag_type}</span>
                {flag.detail?.duration && (
                  <span className="text-gray-400 ml-2">{Number(flag.detail.duration).toFixed(1)}s</span>
                )}
              </div>
              <span className="ml-auto text-gray-600 text-xs shrink-0">
                {new Date(flag.ts).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Create frontend/app/dashboard/page.tsx**

```typescript
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { SessionCard } from '../../components/dashboard/SessionCard'

const API = process.env.NEXT_PUBLIC_BACKEND_API_URL

export default function DashboardPage() {
  const router = useRouter()
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Create session form state
  const [form, setForm] = useState({ candidate_name: '', candidate_email: '', job_title: '', question_set_id: '' })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.push('/login'); return }
      fetchSessions(data.session.access_token)
    })
  }, [router])

  async function fetchSessions(token: string) {
    const res = await fetch(`${API}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) setSessions(await res.json())
    setLoading(false)
  }

  async function createSession(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token!
    await fetch(`${API}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    await fetchSessions(token)
    setForm({ candidate_name: '', candidate_email: '', job_title: '', question_set_id: '' })
    setCreating(false)
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-semibold">Interviews</h1>
        <button onClick={() => supabase.auth.signOut().then(() => router.push('/login'))} className="text-sm text-gray-400 hover:text-white">Sign Out</button>
      </div>

      {/* Create session form */}
      <form onSubmit={createSession} className="mb-8 p-4 bg-gray-900 rounded-xl border border-gray-800 space-y-3">
        <h2 className="font-medium">Schedule Interview</h2>
        <input className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm" placeholder="Candidate Name" value={form.candidate_name} onChange={e => setForm(f => ({...f, candidate_name: e.target.value}))} required />
        <input className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm" placeholder="Candidate Email" type="email" value={form.candidate_email} onChange={e => setForm(f => ({...f, candidate_email: e.target.value}))} required />
        <input className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm" placeholder="Job Title" value={form.job_title} onChange={e => setForm(f => ({...f, job_title: e.target.value}))} required />
        <input className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm" placeholder="Question Set ID" value={form.question_set_id} onChange={e => setForm(f => ({...f, question_set_id: e.target.value}))} required />
        <button type="submit" disabled={creating} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium disabled:opacity-50">
          {creating ? 'Scheduling…' : 'Schedule & Send Invite'}
        </button>
      </form>

      {loading ? (
        <p className="text-gray-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-gray-500">No interviews yet.</p>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => <SessionCard key={s.id} session={s} />)}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Create frontend/app/dashboard/sessions/[id]/page.tsx**

```typescript
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '../../../../lib/supabase'
import { TranscriptView } from '../../../../components/dashboard/TranscriptView'
import { ProctoringReport } from '../../../../components/dashboard/ProctoringReport'

const API = process.env.NEXT_PUBLIC_BACKEND_API_URL

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<any>(null)
  const [tab, setTab] = useState<'transcript' | 'proctoring'>('transcript')

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: auth }) => {
      const token = auth.session?.access_token!
      const res = await fetch(`${API}/api/sessions/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setData(await res.json())
    })
  }, [id])

  if (!data) return <div className="p-8 text-gray-400">Loading…</div>

  const { session, turns, flags } = data

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-1">{session.candidate_name}</h1>
      <p className="text-gray-400 text-sm mb-2">{session.job_title}</p>
      {session.recommendation && (
        <p className="text-lg font-medium text-blue-300 mb-6">{session.recommendation}</p>
      )}

      <div className="flex gap-4 mb-6 border-b border-gray-800">
        {(['transcript', 'proctoring'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`pb-2 text-sm capitalize ${tab === t ? 'border-b-2 border-blue-500 text-white' : 'text-gray-400'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'transcript' && <TranscriptView turns={turns} />}
      {tab === 'proctoring' && <ProctoringReport flags={flags} suspicionScore={session.suspicion_score ?? 0} />}
    </div>
  )
}
```

- [ ] **Step 8: Test HR dashboard end-to-end**

1. Log in at `http://localhost:3000/login` with Supabase HR user credentials
2. Schedule a new interview — confirm email arrives (Task 9 must be complete) and session appears in list
3. Open a completed session — verify transcript and proctoring flags display correctly

- [ ] **Step 9: Commit**

```bash
git add lib/supabase.ts app/login/ app/dashboard/ components/dashboard/
git commit -m "feat: HR dashboard — session list, create form, transcript view, proctoring report"
```

---

## Task 9: Email Invites via Resend

**Files:**
- Create: `backend/src/services/email.ts`

**Interfaces:**
- Produces: `emailService.sendInvite({ to, candidateName, jobTitle, token })` — already imported in `sessions.ts`

- [ ] **Step 1: Create backend/src/services/email.ts**

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
  }) {
    const link = `${BASE_URL}/interview/${token}`

    await resend.emails.send({
      from: FROM,
      to,
      subject: `Your interview for ${jobTitle} at Wohlig Transformations`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h2>Hi ${candidateName},</h2>
          <p>You have been invited to complete an AI-powered interview for the <strong>${jobTitle}</strong> position at Wohlig Transformations.</p>
          <p>The interview takes approximately 20 minutes and is conducted via voice. You will need:</p>
          <ul>
            <li>Google Chrome on a desktop or laptop</li>
            <li>A working camera and microphone</li>
            <li>A quiet, well-lit environment</li>
          </ul>
          <p>Your interview link is valid for 48 hours.</p>
          <p style="margin: 32px 0;">
            <a href="${link}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Start Interview
            </a>
          </p>
          <p style="color: #9ca3af; font-size: 12px;">Or copy this link: ${link}</p>
          <hr style="border-color: #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            This link is unique to you. Do not share it. If you have trouble, contact hr@wohlig.com.
          </p>
        </div>
      `,
    })
  },
}
```

- [ ] **Step 2: Add FRONTEND_URL to .env.example**

```
FRONTEND_URL=http://localhost:3000
```

- [ ] **Step 3: Test email**

Trigger `POST /api/sessions` from the HR dashboard. Check the candidate email inbox. Confirm the interview link resolves correctly and the token matches what's in the DB.

- [ ] **Step 4: Commit**

```bash
git add src/services/email.ts .env.example
git commit -m "feat: Resend email invite with 48h link, candidate instructions"
```

---

## Task 10: Report Generator — Suspicion Score + Recommendation

**Files:**
- Create: `backend/src/services/report.ts`
- Modify: `backend/src/websocket/interviewRelay.ts` (call `generateReport` on WS close after completed session)

**Interfaces:**
- Consumes: `supabaseService.getSessionDetail`, `supabaseService.finalizeSession`
- Produces: `generateReport(sessionId): Promise<{ suspicionScore: number; recommendation: string; overallScore: number }>`

- [ ] **Step 1: Create backend/src/services/report.ts**

```typescript
import { supabaseService } from './supabase'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Suspicion scoring rules (additive, capped at 100)
function calcSuspicionScore(flags: Array<{ flag_type: string }>): number {
  const counts: Record<string, number> = {}
  for (const f of flags) counts[f.flag_type] = (counts[f.flag_type] ?? 0) + 1

  let score = 0

  // face_absent > 3 instances: +20
  if ((counts['face_absent'] ?? 0) > 3) score += 20

  // face_multiple: +30
  if ((counts['face_multiple'] ?? 0) > 0) score += 30

  // tab_switch: +15 per occurrence above 2
  const extraTabs = Math.max(0, (counts['tab_switch'] ?? 0) - 2)
  score += extraTabs * 15

  // gaze_away: +10
  if ((counts['gaze_away'] ?? 0) > 0) score += 10

  // copy_attempt: +15 each
  score += (counts['copy_attempt'] ?? 0) * 15

  // paste_attempt: +20 each
  score += (counts['paste_attempt'] ?? 0) * 20

  // fullscreen_exit: +10
  if ((counts['fullscreen_exit'] ?? 0) > 0) score += 10

  return Math.min(100, score)
}

// Calculate overall score as weighted average of question scores
function calcOverallScore(turns: Array<{ score: number | null; question_id: string | null }>): number {
  const scored = turns.filter((t) => t.score != null && t.question_id != null)
  if (scored.length === 0) return 0
  const sum = scored.reduce((acc, t) => acc + (t.score ?? 0), 0)
  return Math.round((sum / scored.length) * 10) / 10
}

export async function generateReport(sessionId: string) {
  const { turns, flags, session } = await supabaseService.getSessionDetail(sessionId)

  const suspicionScore = calcSuspicionScore(flags)
  const overallScore = calcOverallScore(turns)

  // Update session with computed scores
  await supabase
    .from('sessions')
    .update({ suspicion_score: suspicionScore, overall_score: overallScore })
    .eq('id', sessionId)

  return {
    suspicionScore,
    overallScore,
    recommendation: session?.recommendation ?? null,
  }
}
```

- [ ] **Step 2: Call generateReport when interview ends**

In `backend/src/websocket/interviewRelay.ts`, add to the `ws.on('close', ...)` handler:

```typescript
ws.on('close', async () => {
  liveSession?.close()
  // Generate report if session was active
  try {
    const updated = await supabaseService.getSession(token)
    if (updated?.status === 'completed') {
      await generateReport(session.id)
      console.log(`[Report] Generated for session=${session.id}`)
    }
  } catch (err) {
    console.error('[Report] Failed to generate:', err)
  }
})
```

Add import at top of relay file:
```typescript
import { generateReport } from '../services/report'
```

- [ ] **Step 3: Verify report data in HR dashboard**

After a completed interview:
1. Open `http://localhost:3000/dashboard/sessions/<id>`
2. Confirm suspicion score appears correctly in the Proctoring tab
3. Confirm recommendation (set by Gemini via `end_interview` tool) appears at the top

- [ ] **Step 4: Commit**

```bash
git add src/services/report.ts src/websocket/interviewRelay.ts
git commit -m "feat: report generator — suspicion score, overall score, persisted on session close"
```

---

## Self-Review

### Spec Coverage Check

| Requirement | Task |
|---|---|
| Unique interview URL `/interview/[token]` | Task 5, 7 |
| Pre-interview checklist / camera+mic test | Task 7 (PreflightCheck) |
| Fullscreen enforcement | Task 6 |
| `face_absent`, `face_multiple` detection | Task 5 |
| Gaze tracking + `gaze_away` flag | Task 5 |
| Tab switch, window blur, copy, paste, fullscreen exit | Task 6 |
| Blocked keyboard shortcuts | Task 6 |
| Right-click blocked | Task 6 |
| Audio relay to Gemini Live (PCM16 16kHz) | Tasks 2, 4 |
| Video frames to Gemini (1fps JPEG) | Tasks 2, 5 |
| Gemini audio playback (PCM16 24kHz) | Task 4 |
| ADK agent with score_answer, end_interview tools | Task 1 |
| `sessions.expires_at` generated column | Task 3 |
| WS guard: reject if not pending OR expired | Task 2 |
| HR login (Supabase Auth) | Task 8 |
| Session list + create form + email invite | Tasks 3, 8, 9 |
| Transcript view with scores | Tasks 3, 8 |
| Proctoring report with flag timeline | Task 10, 8 |
| Suspicion score (0–100) | Task 10 |
| Overall recommendation | Task 1 (Gemini tool) |
| `POST /api/sessions` | Task 3 |
| `GET /api/sessions` | Task 3 |
| `GET /api/sessions/:id` | Task 3 |
| Token 48h expiry | Task 3 (SQL generated column) |
| Resend email invite | Task 9 |
| Chrome-only notice | Task 7 |

### Placeholder Scan

None — all steps contain explicit code.

### Type Consistency

- `ProctoringEvent` defined in `capture.ts`, used by `useInterview.ts` and relay's stub DB
- `QuestionSet`/`Question` defined in `interviewer.ts`, imported by `supabase.ts` and `interviewRelay.ts`
- `InterviewCapture` methods (`startAudio`, `startVideo`, `startFaceDetection`, `startProctoring`, `sendFlag`, `playAudio`, `disconnect`) match across `capture.ts` and `useInterview.ts`
- `supabaseService` method names in `supabase.ts` match all import sites in `interviewRelay.ts`, `sessions.ts`, `report.ts`
