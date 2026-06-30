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

  // Open camera first (triggers permission prompt), load models in parallel
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // Start both concurrently so permission prompt shows immediately
        const [stream] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
          initFaceApi(),
        ])
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
