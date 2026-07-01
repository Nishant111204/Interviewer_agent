'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'

interface SessionRow {
  id: string; candidate_name: string; job_title: string; status: string
  overall_score: number | null; suspicion_score: number | null
  recommendation: string | null; summary: string | null
  created_at: string; started_at: string | null; ended_at: string | null
}
interface Turn { id: string; role: string; text: string; score: number | null; ts: string }
interface Flag { id: string; flag_type: string; severity: 'low' | 'medium' | 'high'; ts: string }
interface Detail { session: SessionRow; turns: Turn[]; flags: Flag[] }

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  in_progress: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  completed: 'bg-green-500/10 border-green-500/20 text-green-400',
  cancelled: 'bg-red-500/10 border-red-500/20 text-red-400',
}
const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  medium: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  high: 'bg-red-500/10 border-red-500/20 text-red-400',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function RecommendationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-600">—</span>
  const v = value.toLowerCase()
  if (v.includes('strong hire') || v === 'hire') return <span className="font-semibold text-green-400">✓ {value}</span>
  if (v.includes('no hire') || v === 'reject') return <span className="font-semibold text-red-400">✗ {value}</span>
  return <span className="font-semibold text-amber-400">○ {value}</span>
}

function ScoreRing({ score, max = 10 }: { score: number | null; max?: number }) {
  if (score == null) return <span className="text-3xl font-bold text-slate-600">—</span>
  const color = score >= 7 ? 'text-green-400' : score >= 4 ? 'text-amber-400' : 'text-red-400'
  return <span className={`text-3xl font-bold ${color}`}>{score}/{max}</span>
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
        if (r.status === 404) { setNotFound(true); return }
        setDetail((await r.json()) as Detail)
      })
      .catch(() => setNotFound(true))
  }, [accessToken, params.id])

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="glass-card p-8 text-center">
          <p className="text-slate-400">Session not found.</p>
          <button onClick={() => router.push('/hr')} className="btn-ghost mt-4 py-2 text-sm">← Back</button>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
      </div>
    )
  }

  const { session, turns, flags } = detail
  const displayTurns = turns.filter(t => !t.text.startsWith('[Score:'))

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      <header className="border-b border-white/8 px-6 py-4">
        <div className="mx-auto max-w-5xl">
          <button onClick={() => router.push('/hr')} className="mb-4 flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors">
            ← Back to Sessions
          </button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{session.candidate_name}</h1>
              <p className="mt-0.5 text-slate-400">{session.job_title}</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[session.status] ?? STATUS_STYLES.pending}`}>
                {session.status.replace(/_/g, ' ')}
              </span>
              <span className="text-xs text-slate-600">
                {fmt(session.created_at)}
                {session.ended_at ? ` → ${fmt(session.ended_at)}` : ''}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        {/* Score cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Overall Score</p>
            <ScoreRing score={session.overall_score} />
          </div>
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Suspicion Score</p>
            <span className={`text-3xl font-bold ${
              (session.suspicion_score ?? 0) < 20 ? 'text-green-400'
              : (session.suspicion_score ?? 0) < 50 ? 'text-amber-400'
              : 'text-red-400'
            }`}>
              {session.suspicion_score ?? 0}
            </span>
            <span className="text-slate-600">/100</span>
          </div>
          <div className="glass-card p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Recommendation</p>
            <div className="text-xl font-bold mt-1"><RecommendationBadge value={session.recommendation} /></div>
          </div>
        </div>

        {/* Summary */}
        {session.summary && (
          <div className="glass-card p-5">
            <p className="mb-2 text-xs font-medium text-slate-500 uppercase tracking-wide">AI Summary</p>
            <p className="text-sm text-slate-300 leading-relaxed">{session.summary}</p>
          </div>
        )}

        {/* Transcript */}
        <section>
          <h2 className="mb-4 font-semibold">Transcript</h2>
          {displayTurns.length === 0 ? (
            <p className="text-sm text-slate-600">No transcript recorded.</p>
          ) : (
            <div className="glass-card p-5 space-y-4 max-h-[500px] overflow-y-auto">
              {displayTurns.map(turn => (
                <div key={turn.id} className={`flex ${turn.role === 'model' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    turn.role === 'model'
                      ? 'rounded-tl-sm bg-white/[0.05] border border-white/8 text-slate-200'
                      : 'rounded-tr-sm bg-blue-600/20 border border-blue-500/20 text-blue-100'
                  }`}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`text-xs font-semibold ${turn.role === 'model' ? 'text-blue-400' : 'text-blue-300'}`}>
                        {turn.role === 'model' ? 'Interviewer' : 'Candidate'}
                      </span>
                      {turn.role === 'user' && turn.score != null && (
                        <span className="text-xs text-green-400 font-medium">{turn.score}/10</span>
                      )}
                    </div>
                    <p className="mt-1">{turn.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Proctoring Flags */}
        <section>
          <h2 className="mb-4 font-semibold">Proctoring Flags <span className="text-slate-600 font-normal text-sm">({flags.length})</span></h2>
          {flags.length === 0 ? (
            <div className="glass-card p-5">
              <p className="text-sm text-green-400">✓ No proctoring flags recorded.</p>
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-left">
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Time</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Event</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map(flag => (
                    <tr key={flag.id} className="border-b border-white/5">
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">{fmtTime(flag.ts)}</td>
                      <td className="px-5 py-3 capitalize text-slate-300">{flag.flag_type.replace(/_/g, ' ')}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[flag.severity] ?? SEVERITY_STYLES.low}`}>
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
      </main>
    </div>
  )
}
