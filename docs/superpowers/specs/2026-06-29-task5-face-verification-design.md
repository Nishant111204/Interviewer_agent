# Task 5: Face Verification (face-api.js) — Design Spec

**Date:** 2026-06-29  
**Scope:** Add identity verification to the InterviewAI frontend using face-api.js. Builds on the existing MediaPipe gaze detection already in `lib/mediapipe.ts` and `lib/capture.ts`.

---

## Context

Task 4 is complete (Next.js 14 scaffold, AudioWorklet PCM capture, WebSocket relay).  
Task 5 MediaPipe gaze/head-pose detection is already implemented.  
This spec covers the remaining Task 5 piece: **face-api.js identity verification**.

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `frontend/lib/faceVerify.ts` | Singleton model loader + `generateDescriptor` + `compareDescriptor` |
| `frontend/components/SelfieCapture.tsx` | Preflight selfie UI — camera preview, take photo, confirm |

### Modified files

| File | Change |
|------|--------|
| `frontend/lib/capture.ts` | Add `startFaceVerification`, `stopFaceVerification`, call stop in `disconnect()` |
| Backend candidate router | Add `PATCH /candidate/sessions/:token/descriptor` (separate from auth-protected HR router) |
| Supabase `sessions` table | Add `face_descriptor real[]` column |

### Model assets

face-api.js models are loaded **from CDN at runtime** — same strategy as MediaPipe (which fetches from jsDelivr/GCS). No model files committed to git.

```ts
// in faceVerify.ts — load from unpkg, same pattern as mediapipe.ts uses jsDelivr
const MODEL_URL = 'https://unpkg.com/face-api.js/weights'
```

This avoids ~10MB of binary blobs in git history and stays consistent with the MediaPipe approach.

---

## `lib/faceVerify.ts`

### Return types

```ts
export type DescriptorResult =
  | { ok: true; descriptor: Float32Array }
  | { ok: false; reason: 'no_face' | 'multiple_faces' | 'error'; message: string }

export type CompareResult =
  | { detected: true; distance: number; isMatch: boolean }
  | { detected: false }  // no face visible — skip tick, don't flag
```

### Three exports

```ts
initFaceApi(): Promise<void>
// Loads ssd_mobilenetv1, face_landmark_68, face_recognition from CDN (unpkg).
// Singleton — safe to call multiple times; resolves immediately after first load.
// Shows loading state in caller while awaiting.

generateDescriptor(el: HTMLVideoElement | HTMLImageElement): Promise<DescriptorResult>
// Detects faces. Returns discriminated union:
//   { ok: true, descriptor } — exactly one face detected
//   { ok: false, reason: 'no_face' } — zero faces
//   { ok: false, reason: 'multiple_faces' } — two or more faces
//   { ok: false, reason: 'error', message } — model/runtime error

compareDescriptor(ref: Float32Array, videoEl: HTMLVideoElement): Promise<CompareResult>
// Detects face in current video frame, computes euclideanDistance vs ref.
// Returns { detected: false } if no face visible — caller skips tick.
// isMatch = distance < 0.5
```

Models loaded from CDN, not `public/models/`. No files committed to git.

---

## `components/SelfieCapture.tsx`

Props:
```ts
interface SelfieCaptureProps {
  onCapture: (descriptor: Float32Array) => void
  sessionToken: string
}
```

States:
- `loading` — `initFaceApi()` in progress; show spinner, block "Take Photo"
- `ready` — camera live, button enabled
- `processing` — photo taken, `generateDescriptor` running
- `confirm` — descriptor generated, frozen frame shown, "Continue" button
- `saving` — PATCH in flight
- `error` — show retry-able message

Flow:
1. Mount: call `initFaceApi()` → show spinner until resolved (model load can take 2–5s on slow connections)
2. Camera open (`getUserMedia`, video only) → live preview
3. Candidate clicks "Take Photo" → `generateDescriptor(videoEl)`
   - `reason: 'no_face'` → "No face detected — look directly at the camera and retake"
   - `reason: 'multiple_faces'` → "Only one face should be visible — retake"
   - `reason: 'error'` → "Something went wrong — retake"
   - `ok: true` → freeze frame, show "Looks good — Continue" button
4. Candidate clicks "Continue" → `PATCH /candidate/sessions/:token/descriptor`
   - Body: `{ descriptor: Array.from(descriptor) }`
   - Supabase save fails: surface error, block proceeding
   - 409 Conflict (descriptor already set): treat as success (idempotent)
   - Success: `onCapture(descriptor)` → parent holds in state, interview can start

---

## Backend: Candidate Router

The existing `sessionsRouter` applies `authMiddleware` to all routes — it requires a Clerk/JWT Bearer token from the HR user. The candidate has no JWT; they only have the invite token. A **separate candidate router** is needed (no `authMiddleware`):

```
PATCH /candidate/sessions/:token/descriptor
```

Guards on this endpoint:
1. Look up session by token — return 404 if not found
2. Reject if `status !== 'pending'` — return 403
3. Reject if `face_descriptor IS NOT NULL` — return 409 (one-write semantics, prevents overwrite)
4. Rate limit: 5 requests per token per 60 seconds
5. Write `face_descriptor = $descriptor` to sessions table

This mirrors how the WebSocket relay (`/interview/:token`) already handles candidate auth — token lookup, status check, no JWT.

---

## `capture.ts` additions

```ts
startFaceVerification(ref: Float32Array, videoEl: HTMLVideoElement, onFlag: (e: ProctoringEvent) => void): void
// First check fires immediately (t=0), then every 30 seconds.
// compareDescriptor → detected: false: skip tick (no double-flag with MediaPipe face_absent)
// detected: true, !isMatch: onFlag({ type: 'impersonation', ts, distance }) + sendFlag() over WS
// detected: true, isMatch: no action

stopFaceVerification(): void
// Clears the interval.
```

Private fields added:
```ts
private faceVerifyInterval: ReturnType<typeof setInterval> | null = null
```

`disconnect()` already calls all stop methods — add `stopFaceVerification()` there.

**First-tick matters:** call `compareDescriptor` once immediately on `startFaceVerification`, then start the interval. Without this, a candidate who hands off right after the selfie goes unchecked for 30 seconds.

---

## Data Flow

### Preflight (before interview)

```
SelfieCapture mounts
  → initFaceApi() [spinner while loading]
  → getUserMedia (camera)
  → candidate clicks "Take Photo"
  → generateDescriptor(videoFrame)
      → { ok: false, reason: 'no_face' }: show retake error
      → { ok: false, reason: 'multiple_faces' }: show retake error
      → { ok: true, descriptor }: show confirmation
  → candidate clicks "Continue"
  → PATCH /candidate/sessions/:token/descriptor
      → 409: treat as success (already set)
      → error: surface, block
      → success: sessions.face_descriptor = real[] in Supabase
  → onCapture(descriptor) → parent holds in state
  → interview begins
```

### During interview (every 30 seconds, immediate first tick)

```
startFaceVerification(ref, videoEl, onFlag)
  → compareDescriptor(ref, videoEl)
      → { detected: false }: skip tick
      → { detected: true, isMatch: true }: no action
      → { detected: true, isMatch: false }:
          onFlag({ type: 'impersonation', ts, distance })
          sendFlag() over WS → stored in proctoring_events
```

---

## Supabase Schema Change

```sql
alter table sessions
  add column face_descriptor real[];
-- real[] = Postgres native float4 array — more compact than jsonb for numeric arrays.
-- No NOT NULL — sessions created before this feature won't have a descriptor.
```

`real[]` is preferred over `jsonb` for a pure numeric array: no JSON parsing overhead, compact storage. If similarity search across candidates is ever needed, migrate to `vector(128)` from pgvector at that point.

---

## Security

| Concern | Mitigation |
|---------|-----------|
| Candidate overwrites descriptor mid-interview | One-write semantics: 409 if `face_descriptor IS NOT NULL` |
| Token brute-force / endpoint spam | Rate limit: 5 req/token/60s on candidate router |
| Descriptor endpoint reachable by HR router (JWT-protected) | Separate candidate router — no `authMiddleware` |
| Descriptor missing at interview start | `startFaceVerification` is a no-op if `ref` is null/undefined — log warning, don't crash |

---

## Error Handling

| Scenario | Handling |
|----------|---------|
| No face in selfie | `DescriptorResult { ok: false, reason: 'no_face' }` → retake error |
| Multiple faces in selfie | `{ ok: false, reason: 'multiple_faces' }` → retake error |
| Models fail to load | `initFaceApi` throws → SelfieCapture error state, interview blocked |
| Face absent during 30s check | `CompareResult { detected: false }` → skip tick |
| Supabase descriptor save fails | Surface error in SelfieCapture, block proceeding |
| Descriptor already set (409) | Treat as success — idempotent |

---

## Out of Scope (Task 5)

- Full preflight wizard UI (Task 7)
- HR dashboard display of impersonation flags (Task 8)
- Liveness detection (anti-spoofing with a printed photo)
- pgvector migration for cross-candidate similarity search
