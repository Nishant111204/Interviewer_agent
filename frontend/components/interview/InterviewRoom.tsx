'use client'

import { useEffect, useRef, useState } from 'react'
import type { InterviewStatus, TranscriptTurn } from '../../hooks/useInterview'
import type { ProctoringEvent } from '../../lib/capture'

interface InterviewRoomProps {
  session: { candidateName: string; role: string }
  status: InterviewStatus
  transcript: TranscriptTurn[]
  flags: ProctoringEvent[]
  error: string | null
  isSpeaking: boolean
  videoRef: React.RefObject<HTMLVideoElement>
  onStop: () => void
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function InterviewRoom({
  session,
  status,
  transcript,
  flags,
  error,
  isSpeaking,
  videoRef,
  onStop,
}: InterviewRoomProps) {
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript.length])

  function handleStopClick() {
    if (showConfirm) { setShowConfirm(false); onStop() }
    else setShowConfirm(true)
  }

  return (
    <div className="flex h-screen flex-col bg-navy-950">
      {/* Header bar */}
      <header className="flex items-center justify-between border-b border-white/8 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{session.candidateName}</span>
          <span className="text-slate-600">·</span>
          <span className="text-sm text-slate-400">{session.role}</span>
        </div>

        <div className="flex items-center gap-4">
          {/* Timer */}
          <span className="font-mono text-sm text-slate-400">{formatElapsed(elapsed)}</span>

          {/* Status */}
          {status === 'connecting' && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
              <span className="text-xs text-slate-500">Connecting…</span>
            </div>
          )}
          {status === 'active' && !isSpeaking && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              <span className="text-xs text-green-400">Live</span>
            </div>
          )}
          {status === 'active' && isSpeaking && (
            <div className="flex items-center gap-2">
              {/* 5-bar waveform */}
              <div className="flex items-end gap-0.5 h-4">
                {[0, 1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className="w-0.5 rounded-full bg-blue-400 animate-waveform"
                    style={{ animationDelay: `${i * 0.12}s`, minHeight: '4px' }}
                  />
                ))}
              </div>
              <span className="text-xs text-blue-400">AI Speaking</span>
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-red-500" />
              <span className="text-xs text-red-400">Disconnected</span>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden gap-0 lg:gap-6 p-4 lg:p-6">
        {/* Left column: camera + controls */}
        <div className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
          {/* Error banner */}
          {status === 'error' && error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Camera feed */}
          <div className="relative overflow-hidden rounded-2xl bg-navy-900 border border-white/8">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full object-cover"
              style={{ aspectRatio: '4/3' }}
            />
            {/* Speaking glow overlay */}
            {isSpeaking && (
              <div className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-blue-500/40 ring-inset" />
            )}
            {/* Proctoring flag count */}
            {flags.length > 0 && (
              <div className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-amber-400 backdrop-blur-sm">
                ⚑ {flags.length}
              </div>
            )}
          </div>

          {/* Stop button */}
          <div className="mt-auto">
            {showConfirm ? (
              <div className="flex flex-col gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                <p className="text-center text-sm text-slate-400">End the interview?</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleStopClick}
                    className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-all"
                  >
                    Yes, end it
                  </button>
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 rounded-xl bg-white/5 py-2 text-sm font-semibold hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={handleStopClick}
                disabled={status !== 'active'}
                className="w-full rounded-xl border border-red-500/20 bg-red-500/10 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition-all disabled:cursor-not-allowed disabled:opacity-40"
              >
                End Interview
              </button>
            )}
          </div>
        </div>

        {/* Right column: transcript */}
        <div className="hidden lg:flex flex-1 flex-col min-h-0">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-600">
            Transcript
          </p>
          <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl bg-navy-900 border border-white/8 p-5">
            {transcript.length === 0 ? (
              <p className="text-sm italic text-slate-600 text-center mt-8">
                The interview will begin momentarily…
              </p>
            ) : (
              transcript.map((turn, i) => (
                <div
                  key={i}
                  className={`flex ${turn.role === 'model' ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      turn.role === 'model'
                        ? 'rounded-tl-sm bg-white/[0.06] border border-white/8 text-slate-200'
                        : 'rounded-tr-sm bg-blue-600/20 border border-blue-500/20 text-blue-100'
                    }`}
                  >
                    <p className={`mb-1 text-xs font-semibold ${turn.role === 'model' ? 'text-blue-400' : 'text-blue-300'}`}>
                      {turn.role === 'model' ? 'Interviewer' : 'You'}
                    </p>
                    <p>{turn.text}</p>
                  </div>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
