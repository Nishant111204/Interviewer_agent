# Task 6: Browser Proctoring Events + `useInterview` Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `useInterview` React hook that owns the full `InterviewCapture` lifecycle and wires all browser proctoring event listeners, ready for Task 7 to consume.

**Architecture:** `lib/proctoring.ts` is a pure utility (no React) that attaches/detaches seven browser event listeners and returns a cleanup function. `hooks/useInterview.ts` wraps `InterviewCapture`, calls `attachProctoringListeners`, manages a status machine, and returns `{ status, transcript, flags, error, videoRef, start, stop }`. A small patch to `lib/capture.ts` adds an `onClose` callback so the hook can detect unexpected WS disconnection.

**Tech Stack:** Next.js 14 App Router, TypeScript, React hooks (`useRef`, `useState`, `useCallback`, `useEffect`)

## Global Constraints

- `hooks/useInterview.ts` must start with `'use client'` — uses browser APIs
- `lib/proctoring.ts` has NO React imports — pure browser API module
- All listener references must be stored in named variables so `removeEventListener` can remove the exact same function reference
- Debounce delay for `tab_switch` and `window_blur`: exactly 500 ms
- Keyboard shortcuts to flag: Ctrl/Cmd+C, Ctrl/Cmd+V, Ctrl+Tab, Alt+Tab, F12, Ctrl+Shift+I
- `start()` is a no-op if `status !== 'idle'`
- `videoRef.current` must be non-null when `start()` is called — if null, set `status = 'error'`
- `disconnect()` in `capture.ts` must null `onCloseCb` before closing so intentional stops don't trigger the error callback
- After all edits, run `npx tsc --noEmit` from `frontend/` — zero errors required

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `frontend/lib/capture.ts` | Add `onCloseCb` field, `onClose()` method, wire in `connect()` and null in `disconnect()` |
| Create | `frontend/lib/proctoring.ts` | Attach/detach 7 browser event listeners, debounce, return cleanup fn |
| Create | `frontend/hooks/useInterview.ts` | Status machine, transcript/flags state, `start()`/`stop()`, `videoRef` |

---

## Task 1: Patch `capture.ts` + Create `lib/proctoring.ts`

**Files:**
- Modify: `frontend/lib/capture.ts`
- Create: `frontend/lib/proctoring.ts`

**Interfaces:**
- Produces:
  - `InterviewCapture.onClose(cb: () => void): void` — hook calls this to detect unexpected WS closure
  - `attachProctoringListeners(onFlag: (event: ProctoringEvent) => void): () => void` — returns detach fn

- [ ] **Step 1: Add `onClose` support to `frontend/lib/capture.ts`**

Open `frontend/lib/capture.ts`. Make three small edits:

**1a — Add private field** after the existing `private onTranscriptCb` line (around line 21):
```ts
  private onCloseCb: (() => void) | null = null
```

**1b — Add `onClose` method** after the existing `onTranscript` method (around line 64):
```ts
  onClose(cb: () => void) { this.onCloseCb = cb }
```

**1c — Wire onclose in `connect()`** — add one line inside the `new Promise` block, after `this.ws.onmessage`:
```ts
      this.ws.onclose = () => { this.onCloseCb?.() }
```

**1d — Null `onCloseCb` in `disconnect()`** — add as the FIRST line of `disconnect()`:
```ts
  disconnect() {
    this.onCloseCb = null   // prevent error callback on intentional stop
    this.stopAudio()
    this.stopVideo()
    this.stopFaceDetection()
    this.stopFaceVerification()
    this.ws?.close()
    this.ws = null
  }
```

- [ ] **Step 2: Create `frontend/lib/proctoring.ts`**

```ts
import type { ProctoringEvent } from './capture'

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

export function attachProctoringListeners(
  onFlag: (event: ProctoringEvent) => void,
): () => void {
  let wasFullscreen = false

  function now() { return new Date().toISOString() }

  // Debounced — noisy events fire only after 500 ms of sustained state
  const handleVisibilityChange = debounce(() => {
    if (document.hidden) {
      try { onFlag({ type: 'tab_switch', ts: now() }) } catch (e) {
        console.error('[proctoring] tab_switch handler error:', e)
      }
    }
  }, 500)

  const handleWindowBlur = debounce(() => {
    try { onFlag({ type: 'window_blur', ts: now() }) } catch (e) {
      console.error('[proctoring] window_blur handler error:', e)
    }
  }, 500)

  // Direct — fire immediately, preventDefault to block action
  function handleCopy(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'copy_attempt', ts: now() }) } catch (e) {
      console.error('[proctoring] copy_attempt handler error:', e)
    }
  }

  function handlePaste(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'paste_attempt', ts: now() }) } catch (e) {
      console.error('[proctoring] paste_attempt handler error:', e)
    }
  }

  function handleFullscreenChange() {
    if (document.fullscreenElement !== null) {
      wasFullscreen = true
    } else if (wasFullscreen) {
      try { onFlag({ type: 'fullscreen_exit', ts: now() }) } catch (e) {
        console.error('[proctoring] fullscreen_exit handler error:', e)
      }
    }
  }

  function handleContextMenu(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'right_click', ts: now() }) } catch (e) {
      console.error('[proctoring] right_click handler error:', e)
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey
    const flagged =
      (ctrl && e.key === 'c') ||
      (ctrl && e.key === 'v') ||
      (ctrl && e.key === 'Tab') ||
      (e.altKey && e.key === 'Tab') ||
      e.key === 'F12' ||
      (ctrl && e.shiftKey && (e.key === 'I' || e.key === 'i'))

    if (flagged) {
      try {
        onFlag({
          type: 'keyboard_shortcut',
          ts: now(),
          key: e.key,
          ctrl: e.ctrlKey || e.metaKey,
          alt: e.altKey,
          shift: e.shiftKey,
        })
      } catch (err) {
        console.error('[proctoring] keyboard_shortcut handler error:', err)
      }
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('blur', handleWindowBlur)
  document.addEventListener('copy', handleCopy)
  document.addEventListener('paste', handlePaste)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('contextmenu', handleContextMenu)
  window.addEventListener('keydown', handleKeyDown)

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('blur', handleWindowBlur)
    document.removeEventListener('copy', handleCopy)
    document.removeEventListener('paste', handlePaste)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('contextmenu', handleContextMenu)
    window.removeEventListener('keydown', handleKeyDown)
  }
}
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors. If `onClose` causes a type error, verify the field was added to the class body (not outside it).

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/capture.ts frontend/lib/proctoring.ts
git commit -m "feat: add onClose callback to InterviewCapture, add proctoring event listeners"
```

---

## Task 2: Create `hooks/useInterview.ts`

**Files:**
- Create: `frontend/hooks/useInterview.ts`

**Interfaces:**
- Consumes:
  - `InterviewCapture` from `../lib/capture` — methods: `onClose`, `onAudio`, `onTranscript`, `connect`, `startAudio`, `startVideo`, `startFaceDetection`, `startFaceVerification`, `sendFlag`, `playAudio`, `disconnect`
  - `ProctoringEvent` from `../lib/capture`
  - `attachProctoringListeners` from `../lib/proctoring` (Task 1)
- Produces:
  - `useInterview(sessionToken, referenceDescriptor, backendWsUrl): UseInterviewReturn`
  - `InterviewStatus` type (exported)
  - `TranscriptTurn` interface (exported)
  - `UseInterviewReturn` interface (exported)

- [ ] **Step 1: Create `frontend/hooks/useInterview.ts`**

```ts
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
  videoRef: React.RefObject<HTMLVideoElement>
  start: () => Promise<void>
  stop: () => void
}

export function useInterview(
  sessionToken: string,
  referenceDescriptor: Float32Array | null,
  backendWsUrl: string,
): UseInterviewReturn {
  const [status, setStatus] = useState<InterviewStatus>('idle')
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([])
  const [flags, setFlags] = useState<ProctoringEvent[]>([])
  const [error, setError] = useState<string | null>(null)

  const captureRef = useRef<InterviewCapture | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const onFlag = useCallback((event: ProctoringEvent) => {
    setFlags(prev => [...prev, event])
    captureRef.current?.sendFlag(event)
  }, [])

  const stop = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
    captureRef.current?.disconnect()
    captureRef.current = null
    setStatus('ended')
  }, [])

  const start = useCallback(async () => {
    if (status !== 'idle') return

    const videoEl = videoRef.current
    if (!videoEl) {
      setError('Video element not mounted — attach videoRef to a <video> element before calling start()')
      setStatus('error')
      return
    }

    setStatus('connecting')
    setError(null)

    const capture = new InterviewCapture(sessionToken)
    captureRef.current = capture

    // Detect unexpected WS closure during active interview
    capture.onClose(() => {
      setStatus(prev => (prev === 'active' ? 'error' : prev))
      setError('Connection lost')
    })

    capture.onAudio((base64) => {
      capture.playAudio(base64).catch((err) =>
        console.error('[useInterview] playAudio error:', err),
      )
    })

    capture.onTranscript((role, text) => {
      setTranscript(prev => [
        ...prev,
        { role: role as 'user' | 'model', text, ts: new Date().toISOString() },
      ])
    })

    try {
      await capture.connect(backendWsUrl)
      await capture.startAudio()
      await capture.startVideo(videoEl)
      await capture.startFaceDetection(videoEl, onFlag)

      if (referenceDescriptor) {
        capture.startFaceVerification(referenceDescriptor, videoEl, onFlag)
      }

      detachRef.current = attachProctoringListeners(onFlag)
      setStatus('active')
    } catch (err) {
      capture.disconnect()
      captureRef.current = null
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('error')
    }
  }, [status, sessionToken, backendWsUrl, referenceDescriptor, onFlag])

  // Tear down on unmount (e.g. navigation away mid-interview)
  useEffect(() => {
    return () => {
      detachRef.current?.()
      captureRef.current?.disconnect()
    }
  }, [])

  return { status, transcript, flags, error, videoRef, start, stop }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd frontend && node_modules/.bin/tsc --noEmit
```

Expected: zero errors.

Common errors to watch for:
- `Property 'onClose' does not exist on type 'InterviewCapture'` → Task 1 patch to `capture.ts` was not applied
- `Cannot find module '../lib/proctoring'` → Task 1 `proctoring.ts` was not created
- `Type 'MutableRefObject<HTMLVideoElement | null>' is not assignable to type 'RefObject<HTMLVideoElement>'` → change `useRef<HTMLVideoElement>(null)` to `useRef<HTMLVideoElement | null>(null)` if needed for your React version

- [ ] **Step 3: Smoke-test in browser**

Temporarily add a usage to `app/page.tsx` to verify the hook works:

```tsx
'use client'
import { useEffect, useRef } from 'react'
import { useInterview } from '../hooks/useInterview'

export default function Home() {
  const { status, transcript, flags, error, videoRef, start, stop } = useInterview(
    'test-token',
    null,
    'ws://localhost:3001',
  )

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <video ref={videoRef} className="w-64 rounded bg-gray-900" muted playsInline />
      <p>Status: <strong>{status}</strong></p>
      {error && <p className="text-red-500">{error}</p>}
      <div className="flex gap-3">
        <button onClick={start} disabled={status !== 'idle'}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
          Start
        </button>
        <button onClick={stop} disabled={status !== 'active'}
          className="px-4 py-2 bg-red-600 text-white rounded disabled:opacity-50">
          Stop
        </button>
      </div>
      <div className="text-sm text-gray-500">
        Flags: {flags.length} | Transcript turns: {transcript.length}
      </div>
    </main>
  )
}
```

Run `npm run dev` in the frontend directory. Open `http://localhost:3000`. Verify:

1. Status shows `idle`, Start button enabled
2. Click Start → status briefly shows `connecting`, then `error` (expected — no real WS server running with that token). Error message shown.
3. Right-click on the page → confirm the browser's context menu is blocked (once status is `active` with a real backend)
4. No TypeScript errors in the terminal

Remove the test code from `page.tsx` before committing.

- [ ] **Step 4: Revert `app/page.tsx` and commit**

Restore `frontend/app/page.tsx` to:
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-bold tracking-tight">InterviewAI</h1>
    </main>
  )
}
```

Then commit:
```bash
git add frontend/hooks/useInterview.ts frontend/app/page.tsx
git commit -m "feat: add useInterview hook — status machine, transcript/flags state, start/stop"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `attachProctoringListeners(onFlag) → () => void` | Task 1 |
| `tab_switch` — `visibilitychange`, debounced 500ms | Task 1 |
| `window_blur` — `window.blur`, debounced 500ms | Task 1 |
| `copy_attempt` — `document.copy`, preventDefault | Task 1 |
| `paste_attempt` — `document.paste`, preventDefault | Task 1 |
| `fullscreen_exit` — `fullscreenchange`, wasFullscreen tracking | Task 1 |
| `right_click` — `contextmenu`, preventDefault | Task 1 |
| `keyboard_shortcut` — Ctrl/Cmd+C/V, Ctrl+Tab, Alt+Tab, F12, Ctrl+Shift+I | Task 1 |
| Named function references for removeEventListener | Task 1 |
| Try/catch in each listener — don't crash interview | Task 1 |
| `onClose` on `InterviewCapture` | Task 1 |
| `disconnect()` nulls `onCloseCb` before closing | Task 1 |
| `useInterview(sessionToken, referenceDescriptor, backendWsUrl)` signature | Task 2 |
| `status: InterviewStatus` — `idle/connecting/active/ended/error` | Task 2 |
| `transcript: TranscriptTurn[]` — `{ role, text, ts }` | Task 2 |
| `flags: ProctoringEvent[]` | Task 2 |
| `error: string \| null` | Task 2 |
| `videoRef` returned from hook | Task 2 |
| `start()` no-op if `status !== 'idle'` | Task 2 |
| `start()` sets `error` if `videoRef.current` is null | Task 2 |
| `start()` sequence: callbacks → connect → audio → video → faceDetection → faceVerification → proctoring | Task 2 |
| `onFlag` shared by faceDetection, faceVerification, proctoring | Task 2 |
| `stop()`: detach listeners → disconnect → `status = 'ended'` | Task 2 |
| `useEffect` cleanup on unmount | Task 2 |
| Unexpected WS close → `status = 'error'`, `error = 'Connection lost'` | Task 2 |
| Intentional `stop()` does not trigger error callback | Task 1 (`disconnect()` nulls `onCloseCb`) |

All spec requirements covered. ✓

### Type consistency check

- `ProctoringEvent` imported from `lib/capture` in both Task 1 and Task 2 — same type, no divergence ✓
- `attachProctoringListeners` signature in Task 1 matches the import in Task 2 ✓
- `InterviewCapture.onClose` added in Task 1, consumed in Task 2 ✓
- `TranscriptTurn.role` cast from `string` to `'user' | 'model'` — safe because backend only sends those two values ✓

No placeholders. No TBDs. ✓
