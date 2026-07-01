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
