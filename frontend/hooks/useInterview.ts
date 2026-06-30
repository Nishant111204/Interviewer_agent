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
  const videoRef = useRef<HTMLVideoElement | null>(null)

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
