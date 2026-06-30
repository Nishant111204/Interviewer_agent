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
| `frontend/public/models/*` | face-api.js model weights (downloaded once via script) |
| `frontend/scripts/download-face-models.sh` | One-shot script to pull weights from GitHub releases |

### Modified files

| File | Change |
|------|--------|
| `frontend/lib/capture.ts` | Add `startFaceVerification`, `stopFaceVerification`, call stop in `disconnect()` |
| Supabase `sessions` table | Add `face_descriptor jsonb` column |
| Backend REST API | Add `PATCH /api/sessions/:token/descriptor` endpoint |

---

## `lib/faceVerify.ts`

Three exports:

```ts
initFaceApi(): Promise<void>
// Loads ssd_mobilenetv1, face_landmark_68, face_recognition from /models.
// Singleton — safe to call multiple times; resolves immediately after first load.

generateDescriptor(el: HTMLVideoElement | HTMLImageElement): Promise<Float32Array | null>
// Detects a single face, runs landmarks + recognition.
// Returns 128-float descriptor, or null if no face / multiple faces detected.

compareDescriptor(ref: Float32Array, videoEl: HTMLVideoElement): Promise<{ distance: number; isMatch: boolean } | null>
// Detects face in current video frame, computes euclideanDistance vs ref.
// Returns null if no face visible (don't flag as impersonation — MediaPipe handles face_absent).
// isMatch = distance < 0.5
```

Models loaded from `/models` (served as static assets from `public/models/`).  
Required model groups: `ssd_mobilenetv1`, `face_landmark_68`, `face_recognition`.

---

## `components/SelfieCapture.tsx`

Props:
```ts
interface SelfieCaptureProps {
  onCapture: (descriptor: Float32Array) => void
  sessionToken: string
}
```

Flow:
1. Open camera (`getUserMedia`, video only)
2. Show live preview + "Take Photo" button
3. On click: call `generateDescriptor(videoEl)`
   - Fail (null): show inline error "No face detected — please look directly at the camera and retake"
   - Multiple faces: "Only one face should be visible"
   - Success: show frozen frame + "Looks good — Continue" confirm button
4. On confirm: `PATCH /api/sessions/:token/descriptor` with `{ descriptor: Array.from(descriptor) }`
   - Supabase save fails: surface error, block proceeding
   - Success: call `onCapture(descriptor)`, parent can start interview

---

## `capture.ts` additions

```ts
startFaceVerification(ref: Float32Array, videoEl: HTMLVideoElement, onFlag: (e: ProctoringEvent) => void): void
// Calls compareDescriptor every 30 seconds.
// On mismatch (distance ≥ 0.5): onFlag({ type: 'impersonation', ts, distance })
// then sendFlag() over WebSocket → stored in proctoring_events.
// If compareDescriptor returns null (no face): skip tick, don't double-flag.

stopFaceVerification(): void
// Clears the interval.
```

`disconnect()` already calls all stop methods — add `stopFaceVerification()` there.

Private fields added:
```ts
private faceVerifyInterval: ReturnType<typeof setInterval> | null = null
private faceVerifyRef: Float32Array | null = null
```

---

## Data Flow

### Preflight (before interview)

```
SelfieCapture renders
  → getUserMedia (camera)
  → candidate clicks "Take Photo"
  → generateDescriptor(videoFrame)
      → null: show retake error
      → Float32Array: show confirmation
  → candidate clicks "Continue"
  → PATCH /api/sessions/:token/descriptor
      → sessions.face_descriptor = Array.from(descriptor)  [jsonb]
      → error: surface, block
  → onCapture(descriptor) → parent holds in state
  → interview begins
```

### During interview (every 30 seconds)

```
startFaceVerification(ref, videoEl, onFlag)
  → compareDescriptor(ref, videoEl)
      → null (no face): skip tick
      → { distance, isMatch }:
          isMatch: no action
          !isMatch: onFlag({ type:'impersonation', ts, distance })
                    → sendFlag() over WS
                    → stored in proctoring_events
```

---

## Supabase Schema Change

```sql
alter table sessions
  add column face_descriptor jsonb;
```

No `NOT NULL` constraint — sessions created before this feature ships won't have a descriptor.

---

## Error Handling

| Scenario | Handling |
|----------|---------|
| No face in selfie | `generateDescriptor` → null → SelfieCapture shows retake error |
| Multiple faces in selfie | Same — reject, prompt retake |
| Models fail to load | `initFaceApi` throws → SelfieCapture shows error, interview blocked |
| Face absent during 30s check | `compareDescriptor` → null → skip tick (MediaPipe handles `face_absent`) |
| Supabase descriptor save fails | Surface error in SelfieCapture, block proceeding |
| `face_descriptor` missing at interview start | If descriptor not in state, block `startFaceVerification` — log warning |

---

## Model Weights

Downloaded by `scripts/download-face-models.sh` from the face-api.js GitHub releases.  
Placed in `frontend/public/models/` and committed (or added to `.gitignore` + CI download step).  
Total size: ~10MB.

Required files:
- `ssd_mobilenetv1_model-weights_manifest.json` + shard(s)
- `face_landmark_68_model-weights_manifest.json` + shard(s)
- `face_recognition_model-weights_manifest.json` + shard(s)

---

## Out of Scope (Task 5)

- Full preflight wizard UI (Task 7)
- HR dashboard display of impersonation flags (Task 8)
- Liveness detection (anti-spoofing with a printed photo)
