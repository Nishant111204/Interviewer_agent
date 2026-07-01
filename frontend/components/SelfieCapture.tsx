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
