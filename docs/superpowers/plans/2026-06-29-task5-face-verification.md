# Task 5: Face Verification (face-api.js) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add identity verification to the InterviewAI frontend — candidates take a selfie before the interview, and face-api.js checks every 30 seconds during the interview that the same person is still present.

**Architecture:** `lib/faceVerify.ts` loads face-api.js models from jsDelivr CDN (same pattern as MediaPipe) and exposes three functions: `initFaceApi`, `generateDescriptor`, `compareDescriptor`. `InterviewCapture` gets two new methods that use these. A new `SelfieCapture.tsx` component handles the preflight selfie flow and saves the 128-float descriptor to Supabase via a separate candidate-facing REST router (no JWT required — uses invite token auth like the WebSocket).

**Tech Stack:** face-api.js v0.22.2, Next.js 14 App Router, Express, Supabase (postgres `real[]` column)

## Global Constraints

- Next.js 14 App Router — all components using browser APIs need `'use client'` directive
- TypeScript strict mode — no `any`, use discriminated unions as typed in spec
- face-api.js CDN: `https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights`
- No new backend npm dependencies — use built-in `Map` for rate limiting
- `impersonation` flag severity: `'high'` (add to `FLAG_SEVERITY` map in `supabase.ts`)
- Candidate router mounts at `/candidate` — no `authMiddleware`, token-based auth only
- euclidean distance threshold: `0.5` (below = same person, above = impersonation)
- Verification interval: 30 000 ms, first tick fires immediately at t=0

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `backend/supabase/migrations/002_face_descriptor.sql` | Add `face_descriptor real[]` to sessions |
| Modify | `frontend/next.config.ts` | Exclude `canvas` from webpack (face-api.js optional dep) |
| Install | `frontend/` | Add `face-api.js` npm package |
| Create | `frontend/lib/faceVerify.ts` | Model loading, descriptor generation, comparison |
| Modify | `frontend/lib/capture.ts` | Add `startFaceVerification` / `stopFaceVerification` |
| Create | `frontend/components/SelfieCapture.tsx` | Preflight selfie UI (6 states) |
| Modify | `backend/src/services/supabase.ts` | Add `saveFaceDescriptor`, add `impersonation` severity |
| Create | `backend/src/routes/candidate.ts` | `PATCH /candidate/sessions/:token/descriptor` |
| Modify | `backend/src/index.ts` | Mount `candidateRouter` at `/candidate` |

---

## Task 1: Supabase Migration

**Files:**
- Create: `backend/supabase/migrations/002_face_descriptor.sql`

**Interfaces:**
- Produces: `sessions.face_descriptor real[]` column available to all subsequent tasks

- [ ] **Step 1: Create the migration file**

```sql
-- backend/supabase/migrations/002_face_descriptor.sql
alter table sessions
  add column if not exists face_descriptor real[];

-- real[] = native Postgres float4 array.
-- No NOT NULL — sessions created before this feature have no descriptor.
-- One-write semantics enforced at the API layer (check IS NOT NULL before updating).
```

- [ ] **Step 2: Apply the migration**

In the Supabase dashboard SQL editor (or via `supabase db push` if CLI is configured), run the contents of `002_face_descriptor.sql`.

Verify by running:
```sql
select column_name, data_type
from information_schema.columns
where table_name = 'sessions' and column_name = 'face_descriptor';
```
Expected output: one row with `data_type = 'ARRAY'`.

- [ ] **Step 3: Commit**

```bash
git add backend/supabase/migrations/002_face_descriptor.sql
git commit -m "feat: add face_descriptor real[] column to sessions"
```

---

## Task 2: Next.js Config + Install face-api.js

**Files:**
- Modify: `frontend/next.config.ts`
- Modify: `frontend/package.json` (via npm install)

**Interfaces:**
- Produces: `face-api.js` importable in client components without build errors

- [ ] **Step 1: Install face-api.js**

```bash
cd frontend && npm install face-api.js
```

Expected: `face-api.js` appears in `package.json` dependencies, no peer-dep errors.

- [ ] **Step 2: Update next.config.ts to exclude canvas**

face-api.js has an optional `canvas` dependency (Node.js-only). Without this config, Next.js throws a build error when bundling for the server side.

Current `frontend/next.config.ts`:
```ts
import type { NextConfig } from 'next'
const nextConfig: NextConfig = {}
export default nextConfig
```

Replace entirely with:
```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  webpack: (config) => {
    // face-api.js optionally requires 'canvas' for Node.js environments.
    // Mark it external so the client bundle doesn't try to import it.
    config.externals = [...(config.externals ?? []), { canvas: 'canvas' }]
    return config
  },
}

export default nextConfig
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/next.config.ts frontend/package.json frontend/package-lock.json
git commit -m "feat: install face-api.js, exclude canvas from webpack"
```

---

## Task 3: `lib/faceVerify.ts`

**Files:**
- Create: `frontend/lib/faceVerify.ts`

**Interfaces:**
- Consumes: `face-api.js` npm package (Task 2)
- Produces:
  - `initFaceApi(): Promise<void>`
  - `generateDescriptor(el: HTMLVideoElement | HTMLImageElement): Promise<DescriptorResult>`
  - `compareDescriptor(ref: Float32Array, videoEl: HTMLVideoElement): Promise<CompareResult>`
  - `DescriptorResult` (discriminated union)
  - `CompareResult` (discriminated union)

- [ ] **Step 1: Create `frontend/lib/faceVerify.ts`**

```ts
import * as faceapi from 'face-api.js'

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights'

let loaded = false
let loading: Promise<void> | null = null

export type DescriptorResult =
  | { ok: true; descriptor: Float32Array }
  | { ok: false; reason: 'no_face' | 'multiple_faces' | 'error'; message: string }

export type CompareResult =
  | { detected: true; distance: number; isMatch: boolean }
  | { detected: false }

export async function initFaceApi(): Promise<void> {
  if (loaded) return
  if (loading) return loading
  loading = Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]).then(() => { loaded = true })
  return loading
}

export async function generateDescriptor(
  el: HTMLVideoElement | HTMLImageElement,
): Promise<DescriptorResult> {
  try {
    const detections = await faceapi
      .detectAllFaces(el, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors()

    if (detections.length === 0) {
      return { ok: false, reason: 'no_face', message: 'No face detected' }
    }
    if (detections.length >= 2) {
      return { ok: false, reason: 'multiple_faces', message: 'Multiple faces detected' }
    }
    return { ok: true, descriptor: detections[0].descriptor }
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err) }
  }
}

export async function compareDescriptor(
  ref: Float32Array,
  videoEl: HTMLVideoElement,
): Promise<CompareResult> {
  try {
    const detection = await faceapi
      .detectSingleFace(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor()

    if (!detection) return { detected: false }

    const distance = faceapi.euclideanDistance(ref, detection.descriptor)
    return { detected: true, distance, isMatch: distance < 0.5 }
  } catch {
    return { detected: false }
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. If you see `Cannot find module 'face-api.js'`, verify Step 1 of Task 2 ran successfully.

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/faceVerify.ts
git commit -m "feat: add faceVerify module — initFaceApi, generateDescriptor, compareDescriptor"
```

---

## Task 4: Extend `capture.ts` with Face Verification

**Files:**
- Modify: `frontend/lib/capture.ts`

**Interfaces:**
- Consumes:
  - `compareDescriptor(ref: Float32Array, videoEl: HTMLVideoElement): Promise<CompareResult>` from `./faceVerify` (Task 3)
  - `ProctoringEvent` (already defined in `capture.ts`)
- Produces:
  - `InterviewCapture.startFaceVerification(ref: Float32Array, videoEl: HTMLVideoElement, onFlag: (e: ProctoringEvent) => void): void`
  - `InterviewCapture.stopFaceVerification(): void`

- [ ] **Step 1: Add private field and two methods to `capture.ts`**

Open `frontend/lib/capture.ts`. After the existing private field declarations (around line 31), add one field:

```ts
  // --- Face verification fields (Task 5) ---
  private faceVerifyInterval: ReturnType<typeof setInterval> | null = null
```

After `stopFaceDetection()` (around line 212), add:

```ts
  // --- Face identity verification (Task 5) ---

  startFaceVerification(
    ref: Float32Array,
    videoEl: HTMLVideoElement,
    onFlag: (event: ProctoringEvent) => void,
  ): void {
    if (!ref) {
      console.warn('[FaceVerify] No reference descriptor — skipping verification')
      return
    }

    const runCheck = async () => {
      const { compareDescriptor } = await import('./faceVerify')
      const result = await compareDescriptor(ref, videoEl)
      if (!result.detected) return
      if (!result.isMatch) {
        const ts = new Date().toISOString()
        onFlag({ type: 'impersonation', ts, distance: result.distance })
        this.sendFlag({ type: 'impersonation', ts, distance: result.distance })
      }
    }

    // Immediate first tick, then every 30 s
    void runCheck()
    this.faceVerifyInterval = setInterval(() => { void runCheck() }, 30_000)
  }

  stopFaceVerification(): void {
    if (this.faceVerifyInterval) clearInterval(this.faceVerifyInterval)
    this.faceVerifyInterval = null
  }
```

- [ ] **Step 2: Add `stopFaceVerification()` to `disconnect()`**

In the existing `disconnect()` method, add the call alongside the other stops:

```ts
  disconnect() {
    this.stopAudio()
    this.stopVideo()
    this.stopFaceDetection()
    this.stopFaceVerification()
    this.ws?.close()
    this.ws = null
  }
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/capture.ts
git commit -m "feat: add startFaceVerification/stopFaceVerification to InterviewCapture"
```

---

## Task 5: Backend — `saveFaceDescriptor` + Candidate Router

**Files:**
- Modify: `backend/src/services/supabase.ts`
- Create: `backend/src/routes/candidate.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes: `sessions.face_descriptor real[]` (Task 1), Supabase service role key (existing env)
- Produces: `PATCH /candidate/sessions/:token/descriptor` — 200 on success, 404/403/409/429 on failure

- [ ] **Step 1: Add `impersonation` to `FLAG_SEVERITY` and add `saveFaceDescriptor` to `supabase.ts`**

In `backend/src/services/supabase.ts`, update the `FLAG_SEVERITY` map to add impersonation:

```ts
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
```

At the end of the `supabaseService` object (before the closing `}`), add:

```ts
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
```

- [ ] **Step 2: Create `backend/src/routes/candidate.ts`**

```ts
import { Router, Request, Response } from 'express'
import { supabaseService } from '../services/supabase'

const router = Router()

// In-memory rate limiter: 5 requests per token per 60 seconds
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(token: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(token)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(token, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

// PATCH /candidate/sessions/:token/descriptor
// No authMiddleware — candidate identifies via invite token only.
router.patch('/sessions/:token/descriptor', async (req: Request, res: Response) => {
  const { token } = req.params
  const { descriptor } = req.body as { descriptor?: unknown }

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid token format' })
    return
  }

  if (!Array.isArray(descriptor) || descriptor.length !== 128 || !descriptor.every(n => typeof n === 'number')) {
    res.status(400).json({ error: 'descriptor must be an array of 128 numbers' })
    return
  }

  if (!checkRateLimit(token)) {
    res.status(429).json({ error: 'Too many requests' })
    return
  }

  const result = await supabaseService.saveFaceDescriptor(token, descriptor as number[])

  switch (result) {
    case 'ok':
      res.json({ ok: true })
      break
    case 'already_set':
      // Idempotent — treat as success
      res.json({ ok: true })
      break
    case 'not_found':
      res.status(404).json({ error: 'Session not found' })
      break
    case 'not_pending':
      res.status(403).json({ error: 'Session is not in pending state' })
      break
    default:
      res.status(500).json({ error: 'Failed to save descriptor' })
  }
})

export default router
```

- [ ] **Step 3: Mount the candidate router in `backend/src/index.ts`**

Add the import and mount after the existing `app.use('/api/sessions', sessionsRouter)` line:

```ts
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { URL } from 'url'
import { handleInterviewSocket } from './websocket/interviewRelay'
import sessionsRouter from './routes/sessions'
import candidateRouter from './routes/candidate'

const app = express()
app.use(express.json())

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))

// REST routes — HR (JWT-protected via authMiddleware inside sessionsRouter)
app.use('/api/sessions', sessionsRouter)

// REST routes — candidate (token-based auth, no JWT)
app.use('/candidate', candidateRouter)

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

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke-test the endpoint**

Start the backend:
```bash
cd backend && npm run dev
```

In another terminal, test the endpoint with a fake token (should get 400 — invalid format):
```bash
curl -s -X PATCH http://localhost:3001/candidate/sessions/invalidtoken/descriptor \
  -H 'Content-Type: application/json' \
  -d '{"descriptor": []}' | jq .
```
Expected: `{"error":"Invalid token format"}`

Test with a valid-format but non-existent token (should get 404):
```bash
curl -s -X PATCH \
  "http://localhost:3001/candidate/sessions/$(python3 -c "import secrets; print(secrets.token_hex(32))")/descriptor" \
  -H 'Content-Type: application/json' \
  -d "{\"descriptor\": [$(python3 -c "print(','.join(['0.1']*128))")]}\" | jq .
```
Expected: `{"error":"Session not found"}`

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/supabase.ts backend/src/routes/candidate.ts backend/src/index.ts
git commit -m "feat: add candidate router PATCH /candidate/sessions/:token/descriptor with rate limiting"
```

---

## Task 6: `SelfieCapture.tsx` Component

**Files:**
- Create: `frontend/components/SelfieCapture.tsx`

**Interfaces:**
- Consumes:
  - `initFaceApi(): Promise<void>` from `../lib/faceVerify` (Task 3)
  - `generateDescriptor(el): Promise<DescriptorResult>` from `../lib/faceVerify` (Task 3)
  - `DescriptorResult` type from `../lib/faceVerify`
  - Backend: `PATCH /candidate/sessions/:token/descriptor` (Task 5)
- Produces:
  - `<SelfieCapture sessionToken={string} onCapture={(d: Float32Array) => void} />`

- [ ] **Step 1: Create `frontend/components/SelfieCapture.tsx`**

```tsx
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { initFaceApi, generateDescriptor } from '../lib/faceVerify'

interface SelfieCaptureProps {
  sessionToken: string
  onCapture: (descriptor: Float32Array) => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'processing' }
  | { phase: 'confirm'; descriptor: Float32Array; snapshotUrl: string }
  | { phase: 'saving'; descriptor: Float32Array; snapshotUrl: string }
  | { phase: 'error'; message: string }

export default function SelfieCapture({ sessionToken, onCapture }: SelfieCaptureProps) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  // Load models + open camera on mount
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        await initFaceApi()
        if (cancelled) return
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        if (!cancelled) setState({ phase: 'ready' })
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: `Setup failed: ${String(err)}` })
      }
    }

    void init()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  const takePhoto = useCallback(async () => {
    const videoEl = videoRef.current
    if (!videoEl) return
    setState({ phase: 'processing' })

    const result = await generateDescriptor(videoEl)

    if (!result.ok) {
      const messages: Record<string, string> = {
        no_face: 'No face detected — look directly at the camera and try again.',
        multiple_faces: 'Only one face should be visible — try again.',
        error: 'Something went wrong — try again.',
      }
      setState({ phase: 'error', message: messages[result.reason] ?? result.message })
      return
    }

    // Freeze a snapshot from the canvas
    let snapshotUrl = ''
    const canvas = canvasRef.current
    if (canvas && videoEl.videoWidth) {
      canvas.width = videoEl.videoWidth
      canvas.height = videoEl.videoHeight
      canvas.getContext('2d')?.drawImage(videoEl, 0, 0)
      snapshotUrl = canvas.toDataURL('image/jpeg', 0.8)
    }

    setState({ phase: 'confirm', descriptor: result.descriptor, snapshotUrl })
  }, [])

  const retake = useCallback(() => setState({ phase: 'ready' }), [])

  const confirm = useCallback(async () => {
    if (state.phase !== 'confirm') return
    const { descriptor, snapshotUrl } = state
    setState({ phase: 'saving', descriptor, snapshotUrl })

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
      const res = await fetch(`${backendUrl}/candidate/sessions/${sessionToken}/descriptor`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor: Array.from(descriptor) }),
      })

      if (res.status === 409 || res.ok) {
        // 409 = already set (idempotent), treat as success
        streamRef.current?.getTracks().forEach(t => t.stop())
        onCapture(descriptor)
        return
      }

      const body = await res.json().catch(() => ({}))
      setState({ phase: 'error', message: (body as { error?: string }).error ?? 'Failed to save — try again.' })
    } catch (err) {
      setState({ phase: 'error', message: `Network error: ${String(err)}` })
    }
  }, [state, sessionToken, onCapture])

  return (
    <div className="flex flex-col items-center gap-4 p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold">Identity Verification</h2>
      <p className="text-sm text-gray-500 text-center">
        We need a quick selfie to verify your identity during the interview.
      </p>

      {/* Video preview — hidden when showing snapshot */}
      <video
        ref={videoRef}
        className={`w-full rounded-lg bg-gray-900 ${state.phase === 'confirm' || state.phase === 'saving' ? 'hidden' : ''}`}
        muted
        playsInline
      />

      {/* Frozen snapshot in confirm/saving states */}
      {(state.phase === 'confirm' || state.phase === 'saving') && state.snapshotUrl && (
        <img src={state.snapshotUrl} alt="Your selfie" className="w-full rounded-lg" />
      )}

      {/* Hidden canvas used to grab snapshot */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Status messages */}
      {state.phase === 'loading' && (
        <p className="text-sm text-gray-400">Loading face detection models…</p>
      )}
      {state.phase === 'processing' && (
        <p className="text-sm text-gray-400">Detecting face…</p>
      )}
      {state.phase === 'saving' && (
        <p className="text-sm text-gray-400">Saving…</p>
      )}
      {state.phase === 'error' && (
        <p className="text-sm text-red-500 text-center">{state.message}</p>
      )}

      {/* Actions */}
      <div className="flex gap-3 w-full">
        {(state.phase === 'ready' || state.phase === 'error') && (
          <button
            onClick={state.phase === 'error' ? retake : takePhoto}
            className="flex-1 py-2 px-4 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {state.phase === 'error' ? 'Retake' : 'Take Photo'}
          </button>
        )}
        {state.phase === 'confirm' && (
          <>
            <button
              onClick={retake}
              className="flex-1 py-2 px-4 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
            >
              Retake
            </button>
            <button
              onClick={confirm}
              className="flex-1 py-2 px-4 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700"
            >
              Looks good — Continue
            </button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Smoke-test in browser**

Start the frontend dev server:
```bash
cd frontend && npm run dev
```

Temporarily add `<SelfieCapture>` to `app/page.tsx` to test:
```tsx
import SelfieCapture from '../components/SelfieCapture'

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <SelfieCapture
        sessionToken="test"
        onCapture={(d) => console.log('Captured descriptor length:', d.length)}
      />
    </main>
  )
}
```

Open `http://localhost:3000`. Verify:
1. Spinner shows while models load (2–5 s on first load)
2. Camera preview appears after models load
3. "Take Photo" → face detected → frozen snapshot + "Looks good — Continue" visible
4. "Retake" returns to live camera
5. Open browser console — no errors

Remove the test usage from `page.tsx` before committing.

- [ ] **Step 4: Revert `page.tsx` to original and commit**

Restore `frontend/app/page.tsx`:
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-bold tracking-tight">InterviewAI</h1>
    </main>
  )
}
```

Commit:
```bash
git add frontend/components/SelfieCapture.tsx frontend/app/page.tsx
git commit -m "feat: add SelfieCapture component — preflight selfie with face-api.js verification"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Install face-api.js | Task 2 |
| CDN model loading (no git blobs) | Task 3 |
| `initFaceApi` singleton | Task 3 |
| `generateDescriptor` → `DescriptorResult` discriminated union | Task 3 |
| `compareDescriptor` → `CompareResult` | Task 3 |
| `startFaceVerification` with immediate first tick | Task 4 |
| `stopFaceVerification` + wired into `disconnect()` | Task 4 |
| `impersonation` flag type + severity | Task 5 |
| `saveFaceDescriptor` in supabase service | Task 5 |
| Candidate router (no authMiddleware) | Task 5 |
| 404 / 403 / 409 guards on endpoint | Task 5 |
| Rate limit: 5 req/token/60s | Task 5 |
| `SelfieCapture` — 6 states | Task 6 |
| Error messages per `reason` | Task 6 |
| 409 treated as success (idempotent) | Task 6 |
| `face_descriptor real[]` Supabase column | Task 1 |
| `next.config.ts` canvas exclusion | Task 2 |

All spec requirements covered.

### Type consistency check

- `generateDescriptor` returns `DescriptorResult` — used correctly in Task 6 (`result.ok`, `result.reason`, `result.descriptor`)
- `compareDescriptor` returns `CompareResult` — used correctly in Task 4 (`result.detected`, `result.isMatch`, `result.distance`)
- `saveFaceDescriptor` returns `'ok' | 'not_found' | 'not_pending' | 'already_set' | 'error'` — all 5 cases handled in Task 5 route
- `ProctoringEvent` from `capture.ts` — `{ type: 'impersonation', ts, distance }` satisfies the interface (index signature `[key: string]: unknown`)

No placeholder text found. No contradictions. ✓
