'use client'

import { useState, useEffect } from 'react'
import { useInterview } from '../../../hooks/useInterview'
import { PreflightScreen } from '../../../components/interview/PreflightScreen'
import { InterviewRoom } from '../../../components/interview/InterviewRoom'
import { CompletedScreen } from '../../../components/interview/CompletedScreen'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
const WS_URL = BACKEND_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')

type Phase = 'loading' | 'preflight' | 'interview' | 'completed' | 'error'

interface SessionDetails {
  candidateName: string
  role: string
}

interface InterviewPageProps {
  token: string
}

export function InterviewPage({ token }: InterviewPageProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [session, setSession] = useState<SessionDetails | null>(null)
  const [descriptor, setDescriptor] = useState<Float32Array | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { status, transcript, flags, error, isSpeaking, videoRef, start, stop } = useInterview(
    token,
    descriptor,
    WS_URL,
    stream ?? undefined,
  )

  // Validate token and fetch session details on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/candidate/sessions/${token}`)
      .then(res => {
        if (res.status === 404) throw new Error('Session not found or invalid link.')
        if (res.status === 410) throw new Error('This interview link has expired or was already used. Please contact your recruiter.')
        if (!res.ok) throw new Error('Failed to load session.')
        return res.json() as Promise<SessionDetails>
      })
      .then(data => {
        setSession(data)
        setPhase('preflight')
      })
      .catch(err => {
        setErrorMessage((err as Error).message)
        setPhase('error')
      })
  }, [token])

  // Watch hook status while in interview phase — transition out when done or errored
  useEffect(() => {
    if (phase !== 'interview') return
    if (status === 'ended') {
      setPhase('completed')
    }
    if (status === 'error') {
      setErrorMessage(error ?? 'Connection error')
      setPhase('error')
    }
  }, [status, phase, error])

  // Auto-start once InterviewRoom mounts and <video ref={videoRef}> is in the DOM.
  // Called AFTER render so videoRef.current is non-null.
  useEffect(() => {
    if (phase === 'interview' && status === 'idle') {
      void start()
    }
  }, [phase, status, start])

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
          <p className="text-sm text-slate-500">Loading your interview…</p>
        </div>
      </div>
    )
  }

  if (phase === 'preflight' && session) {
    return (
      <PreflightScreen
        token={token}
        session={session}
        stream={stream}
        descriptor={descriptor}
        onStreamGranted={setStream}
        onCapture={setDescriptor}
        onBegin={() => setPhase('interview')}
      />
    )
  }

  if (phase === 'interview') {
    return (
      <InterviewRoom
        session={session!}
        status={status}
        transcript={transcript}
        flags={flags}
        error={error}
        isSpeaking={isSpeaking}
        videoRef={videoRef}
        onStop={stop}
      />
    )
  }

  if (phase === 'completed') {
    return <CompletedScreen variant="success" session={session} />
  }

  return <CompletedScreen variant="error" session={session} message={errorMessage ?? undefined} />
}
