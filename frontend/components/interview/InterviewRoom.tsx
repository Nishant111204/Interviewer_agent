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
  videoRef: React.RefObject<HTMLVideoElement>
  onStop: () => void
}

export function InterviewRoom({
  session,
  status,
  transcript,
  flags,
  error,
  videoRef,
  onStop,
}: InterviewRoomProps) {
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  // Auto-scroll transcript to bottom on new entries
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript.length])

  function handleStopClick() {
    if (showConfirm) {
      setShowConfirm(false)
      onStop()
    } else {
      setShowConfirm(true)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 p-4 lg:flex-row lg:gap-6 lg:p-8">
      {/* Left column: camera + controls */}
      <div className="flex flex-col gap-4 lg:w-80 lg:shrink-0">
        {/* Status badge */}
        <div className="flex items-center gap-2">
          {status === 'connecting' && (
            <>
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
              <span className="text-sm text-gray-400">Connecting…</span>
            </>
          )}
          {status === 'active' && (
            <>
              <div className="h-3 w-3 animate-pulse rounded-full bg-green-500" />
              <span className="text-sm text-green-400">Live</span>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="h-3 w-3 rounded-full bg-red-500" />
              <span className="text-sm text-red-400">Connection lost</span>
            </>
          )}
        </div>

        {/* Error banner */}
        {status === 'error' && error && (
          <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Camera feed */}
        <div className="relative overflow-hidden rounded-xl bg-gray-900">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full object-cover"
          />
          {/* Flag chip — discreet, count only */}
          {flags.length > 0 && (
            <div className="absolute bottom-3 right-3 rounded-full bg-gray-900/80 px-2.5 py-1 text-xs text-amber-400 backdrop-blur-sm">
              ⚑ {flags.length}
            </div>
          )}
        </div>

        {/* Stop / confirm */}
        <div className="flex flex-col gap-2">
          {showConfirm ? (
            <>
              <p className="text-center text-sm text-gray-400">
                Are you sure? This will end the interview.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleStopClick}
                  className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-semibold transition-colors hover:bg-red-500"
                >
                  Yes, end it
                </button>
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-lg bg-gray-800 py-2 text-sm font-semibold transition-colors hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={handleStopClick}
              disabled={status !== 'active'}
              className="w-full rounded-lg bg-red-700/40 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-700/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              End Interview
            </button>
          )}
        </div>
      </div>

      {/* Right column: transcript */}
      <div className="mt-6 flex flex-1 flex-col lg:mt-0">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Transcript — {session.role} interview
        </h2>
        <div className="flex-1 space-y-4 overflow-y-auto rounded-xl bg-gray-900 p-4 max-h-[70vh]">
          {transcript.length === 0 ? (
            <p className="text-sm italic text-gray-600">The interview will begin shortly…</p>
          ) : (
            transcript.map((turn, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span
                  className={`text-xs font-semibold ${
                    turn.role === 'model' ? 'text-blue-400' : 'text-gray-400'
                  }`}
                >
                  {turn.role === 'model' ? 'Interviewer' : 'You'}
                </span>
                <p className="text-sm leading-relaxed text-gray-200">{turn.text}</p>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  )
}
