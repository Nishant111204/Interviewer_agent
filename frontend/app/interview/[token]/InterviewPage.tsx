'use client'

import { useState, useEffect } from 'react'
import { useInterview } from '../../../hooks/useInterview'
import { PreflightScreen } from '../../../components/interview/PreflightScreen'
import { InterviewRoom } from '../../../components/interview/InterviewRoom'
import { CompletedScreen } from '../../../components/interview/CompletedScreen'

type Phase = 'loading' | 'preflight' | 'interview' | 'completed' | 'error'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { status, transcript, flags, error, videoRef, start, stop } = useInterview(
    token,
    descriptor,
    WS_URL,
  )

  // Fetch session details on mount — validates token before showing selfie screen
  useEffect(() => {
    const REST_BASE = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    fetch(`${REST_BASE}/candidate/sessions/${token}`)
      .then(res => {
        if (res.status === 404) throw new Error('Session not found')
        if (res.status === 410) throw new Error('This interview link has expired or was already used')
        if (!res.ok) throw new Error('Failed to load session')
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
      start()
    }
  }, [phase, status, start])

  // Loading spinner
  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  // Selfie + begin
  if (phase === 'preflight' && session) {
    return (
      <PreflightScreen
        token={token}
        session={session}
        descriptor={descriptor}
        onCapture={setDescriptor}
        onBegin={() => setPhase('interview')}
      />
    )
  }

  // Live interview
  if (phase === 'interview') {
    return (
      <InterviewRoom
        session={session!}
        status={status}
        transcript={transcript}
        flags={flags}
        error={error}
        videoRef={videoRef}
        onStop={stop}
      />
    )
  }

  // Interview ended cleanly
  if (phase === 'completed') {
    return <CompletedScreen variant="success" session={session} />
  }

  // Error at any phase
  return <CompletedScreen variant="error" session={session} message={errorMessage ?? undefined} />
}
