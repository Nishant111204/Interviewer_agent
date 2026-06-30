'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? 'http://localhost:3001'

interface SessionRow {
  id: string
  candidate_name: string
  job_title: string
  status: string
  overall_score: number | null
  recommendation: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

interface Turn {
  id: string
  role: string
  text: string
  score: number | null
  ts: string
}

interface Flag {
  id: string
  flag_type: string
  severity: 'low' | 'medium' | 'high'
  ts: string
}

interface Detail {
  session: SessionRow
  turns: Turn[]
  flags: Flag[]
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-blue-900 text-blue-300',
  completed: 'bg-green-900 text-green-300',
  cancelled: 'bg-red-900 text-red-300',
}

const SEVERITY_BADGE: Record<string, string> = {
  low: 'bg-gray-700 text-gray-300',
  medium: 'bg-amber-900 text-amber-300',
  high: 'bg-red-900 text-red-300',
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function suspicionColor(count: number): string {
  if (count < 3) return 'text-green-400'
  if (count < 7) return 'text-amber-400'
  return 'text-red-400'
}

function RecommendationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-500">—</span>
  const map: Record<string, { label: string; cls: string }> = {
    hire: { label: '✓ Hire', cls: 'text-green-400' },
    reject: { label: '✗ Reject', cls: 'text-red-400' },
    review: { label: '○ Review', cls: 'text-amber-400' },
  }
  const entry = map[value.toLowerCase()]
  if (!entry) return <span>{value}</span>
  return <span className={`font-semibold ${entry.cls}`}>{entry.label}</span>
}

export default function SessionDetailPage({ params }: { params: { id: string } }) {
  const { accessToken } = useAuth()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!accessToken) return
    fetch(`${REST_BASE}/api/sessions/${params.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(async r => {
        if (r.status === 404) {
          setNotFound(true)
          return
        }
        const data = (await r.json()) as Detail
        setDetail(data)
      })
      .catch(() => setNotFound(true))
  }, [accessToken, params.id])

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <p className="text-gray-400">Session not found.</p>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  const { session, turns, flags } = detail

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-white">
      {/* Back */}
      <button
        type="button"
        onClick={() => router.push('/hr')}
        className="mb-6 text-sm text-gray-400 hover:text-white"
      >
        ← Back to Sessions
      </button>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{session.candidate_name}</h1>
          <p className="mt-1 text-gray-400">{session.job_title}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[session.status] ?? 'bg-gray-700 text-gray-300'}`}
          >
            {session.status.replace('_', ' ')}
          </span>
          <span className="text-xs text-gray-500">
            Created {formatDateTime(session.created_at)}
            {session.ended_at ? ` · Ended ${formatDateTime(session.ended_at)}` : ''}
          </span>
        </div>
      </div>

      {/* Score cards */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Overall Score</p>
          <p className="text-2xl font-bold">
            {session.overall_score != null ? `${session.overall_score}/10` : '—'}
          </p>
        </div>
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Proctoring Flags</p>
          <p className={`text-2xl font-bold ${suspicionColor(flags.length)}`}>{flags.length}</p>
        </div>
        <div className="rounded-xl bg-gray-900 p-4">
          <p className="mb-1 text-xs text-gray-400">Recommendation</p>
          <p className="text-2xl font-bold">
            <RecommendationBadge value={session.recommendation} />
          </p>
        </div>
      </div>

      {/* Transcript */}
      <section className="mb-8">
        <h2 className="mb-4 text-lg font-semibold">Transcript</h2>
        {turns.length === 0 ? (
          <p className="text-gray-500">No transcript recorded.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {turns.map(turn => {
              const isScoreNote = turn.text.startsWith('[Score:')
              const isInterviewer = turn.role === 'model'

              if (isScoreNote) {
                return (
                  <div key={turn.id} className="pl-4 border-l border-gray-800">
                    <p className="text-xs italic text-gray-500">{turn.text}</p>
                  </div>
                )
              }

              return (
                <div key={turn.id}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`text-xs font-semibold ${isInterviewer ? 'text-blue-400' : 'text-gray-400'}`}
                    >
                      {isInterviewer ? 'Interviewer' : 'Candidate'}
                    </span>
                    {!isInterviewer && turn.score != null && (
                      <span className="text-xs text-green-400">{turn.score}/10</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-gray-200">{turn.text}</p>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Proctoring Flags */}
      <section>
        <h2 className="mb-4 text-lg font-semibold">Proctoring Flags</h2>
        {flags.length === 0 ? (
          <p className="text-gray-500">No proctoring flags recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900 text-left text-gray-400">
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Severity</th>
                </tr>
              </thead>
              <tbody>
                {flags.map(flag => (
                  <tr key={flag.id} className="border-b border-gray-800">
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">
                      {formatTime(flag.ts)}
                    </td>
                    <td className="px-4 py-2 capitalize">
                      {flag.flag_type.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[flag.severity] ?? 'bg-gray-700 text-gray-300'}`}
                      >
                        {flag.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
