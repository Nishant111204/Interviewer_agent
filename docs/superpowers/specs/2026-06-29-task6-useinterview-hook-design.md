# Task 6: Browser Proctoring Events + `useInterview` Hook — Design Spec

**Date:** 2026-06-29
**Scope:** A `useInterview` React hook that owns the `InterviewCapture` lifecycle and wires all browser proctoring event listeners. Consumed by the Interview UI in Task 7.

---

## Context

Tasks 1–5 complete. The `InterviewCapture` class (`frontend/lib/capture.ts`) already handles:
- WebSocket connection to the backend relay
- Mic capture → AudioWorklet PCM16 → WS
- Gemini audio playback (PCM16 24 kHz)
- Video capture (1 fps JPEG → WS)
- MediaPipe face/gaze detection → `face_absent`, `face_multiple`, `gaze_away` flags
- face-api.js identity verification → `impersonation` flags
- `sendFlag()` over WS → backend → `proctoring_flags` table

Task 6 adds the **browser-side proctoring event listeners** and wraps everything in a single React hook.

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `frontend/hooks/useInterview.ts` | React hook — lifecycle, status machine, transcript/flag state |
| `frontend/lib/proctoring.ts` | Pure utility — attaches/detaches all browser event listeners |

No existing files modified.

---

## `useInterview` Hook

### Signature

```ts
function useInterview(
  sessionToken: string,
  referenceDescriptor: Float32Array | null,
  backendWsUrl: string,
): UseInterviewReturn
```

### Return type

```ts
// ProctoringEvent is imported from lib/capture.ts:
// export interface ProctoringEvent { type: string; ts: string; [key: string]: unknown }

type InterviewStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error'

interface TranscriptTurn {
  role: 'user' | 'model'
  text: string
  ts: string
}

interface UseInterviewReturn {
  status: InterviewStatus
  transcript: TranscriptTurn[]
  flags: ProctoringEvent[]      // from lib/capture.ts
  error: string | null
  videoRef: React.RefObject<HTMLVideoElement>
  start: () => Promise<void>   // requires <video ref={videoRef}> to be mounted first
  stop: () => void
}
```

`videoRef` is owned by the hook and returned so the UI can attach it to `<video>`. The hook controls the stream; the component only supplies the DOM element.

### Status machine

```
idle → connecting   (start() called)
connecting → active (WS open + audio started successfully)
connecting → error  (WS failed or getUserMedia denied)
active → ended      (stop() called, or server closes WS cleanly)
active → error      (unexpected WS close / unrecoverable error)
```

`start()` is a no-op if `status !== 'idle'`.

---

## `start()` Sequence

Sets `status = 'connecting'`, then runs in order. **Precondition:** `videoRef.current` must be non-null (the `<video>` element must be mounted) before `start()` is called. If it is null, reject with an error and set `status = 'error'`.

```
1.  new InterviewCapture(sessionToken)           — stored in captureRef
2.  capture.onAudio(base64 => capture.playAudio(base64))
3.  capture.onTranscript((role, text) =>
        setTranscript(prev => [...prev, { role, text, ts: new Date().toISOString() }]))
4.  capture.connect(backendWsUrl)                — WS handshake
5.  capture.startAudio()                         — mic + AudioWorklet
6.  capture.startVideo(videoRef.current)         — camera stream
7.  capture.startFaceDetection(videoRef.current, onFlag)
8.  if (referenceDescriptor !== null)
        capture.startFaceVerification(referenceDescriptor, videoRef.current, onFlag)
9.  attachProctoringListeners(onFlag)            — browser events
10. status = 'active'
```

If any step throws, call `capture.disconnect()`, set `error` and `status = 'error'`.

### Shared `onFlag` callback

```ts
const onFlag = (event: ProctoringEvent) => {
  setFlags(prev => [...prev, event])   // local state — UI can display flags
  captureRef.current?.sendFlag(event)  // WS → backend → proctoring_flags table
}
```

Used by face detection (step 7), face verification (step 8), and proctoring listeners (step 9).

---

## `stop()` Sequence

```
1. detachProctoringListeners()
2. captureRef.current?.disconnect()   — stopAudio, stopVideo, stopFaceDetection,
                                         stopFaceVerification, ws.close()
3. status = 'ended'
```

Also called from `useEffect` cleanup so navigating away tears everything down.

---

## `lib/proctoring.ts`

Pure module — no React. Returns a cleanup function.

```ts
export function attachProctoringListeners(
  onFlag: (event: ProctoringEvent) => void,
): () => void   // returns detach function
```

### Event table

| Listener target | Event | Flag type | Extra behaviour |
|---|---|---|---|
| `document` | `visibilitychange` | `tab_switch` | Only when `document.hidden === true`; debounced 500 ms |
| `window` | `blur` | `window_blur` | Debounced 500 ms |
| `document` | `copy` | `copy_attempt` | `e.preventDefault()` |
| `document` | `paste` | `paste_attempt` | `e.preventDefault()` |
| `document` | `fullscreenchange` | `fullscreen_exit` | Only when `document.fullscreenElement === null` (was in fullscreen) |
| `document` | `contextmenu` | `right_click` | `e.preventDefault()` |
| `window` | `keydown` | `keyboard_shortcut` | Keys: Ctrl/Cmd+C, Ctrl/Cmd+V, Ctrl+Tab, Alt+Tab, F12, Ctrl+Shift+I |

**Debounce rationale:** `window_blur` and `tab_switch` are noisy — clicking the address bar briefly, OS notifications, etc. produce rapid false positives. 500 ms debounce means only sustained focus loss generates a flag.

**Fullscreen tracking:** The listener must know whether the interview was previously in fullscreen. A local `let wasFullscreen = false` variable tracks this — set to `true` on first `fullscreenchange` where `document.fullscreenElement !== null`, fire flag on subsequent change where it is `null`.

**Cleanup:** All listeners use named function references (not anonymous arrows) so `removeEventListener` works correctly. The returned cleanup function removes all of them.

---

## Data Flow

```
Browser events                    useInterview hook              Backend
──────────────                    ─────────────────              ───────
visibilitychange ──┐
window.blur      ──┤              onFlag(event)
copy/paste       ──┤──────────→  setFlags([...flags, event])
contextmenu      ──┤              capture.sendFlag(event) ──────→ WS → proctoring_flags
keydown          ──┤
fullscreenchange ──┘

Gemini audio ────────────────→   capture.playAudio(base64)
Gemini transcript ───────────→   setTranscript([...turns, turn])
                                  + WS { type:'transcript' }

Mic PCM ─────────────────────→   capture.sendAudio → WS → Gemini Live
Video JPEG ──────────────────→   capture.sendVideo → WS → Gemini Live
```

---

## Error Handling

| Scenario | Handling |
|---|---|
| `getUserMedia` denied | `start()` catches, sets `status = 'error'`, `error = 'Microphone or camera access denied'` |
| WS connection fails | Same — caught in `capture.connect()` rejection |
| WS closes unexpectedly during active interview | `onclose` callback sets `status = 'error'`, `error = 'Connection lost'` |
| `startFaceVerification` called with `null` descriptor | `InterviewCapture` logs warning and is a no-op — interview proceeds without verification |
| Proctoring listener throws | Wrapped in try/catch inside the listener — log error, don't crash interview |

---

## Out of Scope (Task 6)

- Full interview UI (Task 7)
- Fullscreen request / enforcement — Task 7 decides whether to request fullscreen; proctoring.ts only listens for the exit event
- `beforeunload` warning — Task 7 can add a "Are you sure?" dialog; proctoring.ts focuses on silent flag generation
