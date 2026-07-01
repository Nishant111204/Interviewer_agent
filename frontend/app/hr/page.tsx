'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useAuth } from './AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'
const INVITE_BASE = process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ?? 'http://localhost:3000'

interface Session {
  id: string
  candidate_name: string
  candidate_email: string
  job_title: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  overall_score: number | null
  created_at: string
}

interface QuestionSet { id: string; role: string }

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  question_set_id: string
}

const EMPTY_FORM: CreateForm = { candidate_name: '', candidate_email: '', job_title: '', question_set_id: '' }

const STATUS_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  pending:     { dot: 'bg-slate-500',  text: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/20' },
  in_progress: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  completed:   { dot: 'bg-green-500',  text: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
  cancelled:   { dot: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ScoreBar({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-600">—</span>
  const pct = (score / 10) * 100
  const color = score >= 7 ? 'bg-green-500' : score >= 4 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400">{score}/10</span>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="glass-card p-5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1.5 text-3xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
    </div>
  )
}

export default function HrPage() {
  const { accessToken } = useAuth()
  const router = useRouter()
  const [sessions, setSessions] = useState<Session[]>([])
  const [questionSets, setQuestionSets] = useState<QuestionSet[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(null)

  useEffect(() => {
    if (!accessToken) return
    const headers: HeadersInit = { Authorization: `Bearer ${accessToken}` }
    Promise.all([
      fetch(`${REST_BASE}/api/sessions`, { headers }).then(r => r.json()),
      fetch(`${REST_BASE}/api/question-sets`, { headers }).then(r => r.json()),
    ])
      .then(([sess, qs]) => {
        setSessions(Array.isArray(sess) ? (sess as Session[]) : [])
        setQuestionSets(Array.isArray(qs) ? (qs as QuestionSet[]) : [])
        setLoading(false)
      })
      .catch((err: unknown) => { console.error('[hr] failed to load sessions:', err); setLoading(false) })
  }, [accessToken])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setModalError(null)
    try {
      const res = await fetch(`${REST_BASE}/api/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { id, token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [{
        id, candidate_name: form.candidate_name, candidate_email: form.candidate_email,
        job_title: form.job_title, status: 'pending', overall_score: null,
        created_at: new Date().toISOString(),
      }, ...prev])
    } catch { setModalError('Network error') }
    finally { setSubmitting(false) }
  }

  function closeModal() { setShowModal(false); setInviteToken(null); setModalError(null); setForm(EMPTY_FORM) }

  // Stats
  const inProgress = sessions.filter(s => s.status === 'in_progress').length
  const completed = sessions.filter(s => s.status === 'completed').length
  const scores = sessions.map(s => s.overall_score).filter((s): s is number => s != null)
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—'

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      {/* Top bar */}
      <header className="border-b border-white/8 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/20 border border-blue-500/20">
              <svg className="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
              </svg>
            </div>
            <span className="font-semibold">InterviewAI</span>
            <span className="rounded-full bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400 font-medium border border-blue-500/20">HR</span>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">
              + New Interview
            </button>
            <button onClick={() => supabase.auth.signOut()} className="btn-ghost py-2 text-sm">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Stats */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total Sessions" value={sessions.length} />
          <StatCard label="In Progress" value={inProgress} sub={inProgress > 0 ? 'Active now' : 'None active'} />
          <StatCard label="Completed" value={completed} />
          <StatCard label="Avg Score" value={avgScore} sub={scores.length > 0 ? `from ${scores.length} interviews` : 'No scores yet'} />
        </div>

        {/* Sessions table */}
        <div className="glass-card overflow-hidden">
          <div className="border-b border-white/8 px-5 py-4">
            <h2 className="font-semibold">Interview Sessions</h2>
          </div>
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-slate-500">No sessions yet.</p>
              <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">
                Create your first interview
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-left">
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Candidate</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Role</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Score</th>
                    <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Created</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => {
                    const style = STATUS_STYLES[s.status] ?? STATUS_STYLES.pending
                    return (
                      <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                        <td className="px-5 py-3.5">
                          <p className="font-medium">{s.candidate_name}</p>
                          <p className="text-xs text-slate-600">{s.candidate_email}</p>
                        </td>
                        <td className="px-5 py-3.5 text-slate-400">{s.job_title}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                            {s.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-5 py-3.5"><ScoreBar score={s.overall_score} /></td>
                        <td className="px-5 py-3.5 text-slate-500 text-xs">{formatDate(s.created_at)}</td>
                        <td className="px-5 py-3.5">
                          <button
                            onClick={() => router.push(`/hr/sessions/${s.id}`)}
                            className="rounded-lg bg-white/5 border border-white/8 px-3 py-1.5 text-xs font-medium hover:bg-white/10 transition-all"
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Create Interview Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            {inviteToken ? (
              <>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/15 border border-green-500/20">
                  <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                  </svg>
                </div>
                <h2 className="mb-1 text-lg font-bold text-green-400">Invite Created</h2>
                <p className="mb-4 text-sm text-slate-400">Copy this link and send it to the candidate:</p>
                <div className="mb-4 flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2">
                  <span className="flex-1 truncate text-xs text-slate-300">{`${INVITE_BASE}/interview/${inviteToken}`}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(`${INVITE_BASE}/interview/${inviteToken}`)}
                    className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium hover:bg-blue-500 transition-all"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => { setInviteToken(null); setModalError(null); setForm(EMPTY_FORM) }} className="btn-ghost flex-1 py-2 text-sm">Create Another</button>
                  <button onClick={closeModal} className="btn-primary flex-1 py-2 text-sm">Done</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="mb-5 text-lg font-bold">New Interview</h2>
                <form onSubmit={handleCreate} className="flex flex-col gap-4">
                  {([
                    { label: 'Candidate Name', key: 'candidate_name', type: 'text', placeholder: 'Jane Smith' },
                    { label: 'Candidate Email', key: 'candidate_email', type: 'email', placeholder: 'jane@example.com' },
                    { label: 'Job Title', key: 'job_title', type: 'text', placeholder: 'Senior Frontend Developer' },
                  ] as const).map(field => (
                    <div key={field.key}>
                      <label className="mb-1.5 block text-sm text-slate-400">{field.label}</label>
                      <input
                        type={field.type}
                        value={form[field.key]}
                        onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                        required
                        placeholder={field.placeholder}
                        className="input-field"
                      />
                    </div>
                  ))}
                  <div>
                    <label className="mb-1.5 block text-sm text-slate-400">Question Set</label>
                    <select
                      value={form.question_set_id}
                      onChange={e => setForm(f => ({ ...f, question_set_id: e.target.value }))}
                      required
                      className="input-field"
                    >
                      <option value="">Select a question set…</option>
                      {questionSets.map(qs => <option key={qs.id} value={qs.id}>{qs.role}</option>)}
                    </select>
                  </div>
                  {modalError && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                  )}
                  <div className="flex gap-3 pt-1">
                    <button type="button" onClick={closeModal} className="btn-ghost flex-1 py-2 text-sm">Cancel</button>
                    <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2 text-sm">
                      {submitting ? 'Creating…' : 'Create & Send Invite'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
