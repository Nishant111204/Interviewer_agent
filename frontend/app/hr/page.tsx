'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useAuth } from './AuthContext'

const REST_BASE = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? 'http://localhost:3001'
const INVITE_BASE = process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ?? 'http://localhost:3000'

interface Session {
  id: string
  candidate_name: string
  job_title: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  overall_score: number | null
  created_at: string
}

interface QuestionSet {
  id: string
  role: string
}

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  question_set_id: string
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-blue-900 text-blue-300 animate-pulse',
  completed: 'bg-green-900 text-green-300',
  cancelled: 'bg-red-900 text-red-300',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const EMPTY_FORM: CreateForm = {
  candidate_name: '',
  candidate_email: '',
  job_title: '',
  question_set_id: '',
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
      .catch(() => setLoading(false))
  }, [accessToken])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setModalError(null)
    try {
      const res = await fetch(`${REST_BASE}/api/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { id, token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [
        {
          id: id,
          candidate_name: form.candidate_name,
          job_title: form.job_title,
          status: 'pending',
          overall_score: null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ])
    } catch {
      setModalError('Network error')
    } finally {
      setSubmitting(false)
    }
  }

  function closeModal() {
    setShowModal(false)
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
  }

  function handleCreateAnother() {
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-blue-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-white">
      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">InterviewAI HR</h1>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500"
          >
            New Interview
          </button>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Sessions table */}
      {sessions.length === 0 ? (
        <p className="text-gray-500">No sessions yet. Create one using &ldquo;New Interview&rdquo;.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900 text-left text-gray-400">
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Job Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id} className="border-b border-gray-800 hover:bg-gray-900">
                  <td className="px-4 py-3 font-medium">{s.candidate_name}</td>
                  <td className="px-4 py-3 text-gray-400">{s.job_title}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[s.status] ?? 'bg-gray-700 text-gray-300'}`}
                    >
                      {s.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{formatDate(s.created_at)}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {s.overall_score != null ? `${s.overall_score}/10` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => router.push(`/hr/sessions/${s.id}`)}
                      className="rounded bg-gray-800 px-3 py-1 text-xs hover:bg-gray-700"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Interview Modal */}
      {showModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-gray-900 p-6">
            {inviteToken ? (
              /* Success state — show invite link */
              <>
                <h2 className="mb-4 text-lg font-bold text-green-400">✅ Invite Created</h2>
                <p className="mb-2 text-sm text-gray-400">
                  Copy this link and send it to the candidate:
                </p>
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2">
                  <span className="flex-1 truncate text-xs text-gray-300">
                    {`${INVITE_BASE}/interview/${inviteToken}`}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard.writeText(`${INVITE_BASE}/interview/${inviteToken}`)
                    }
                    className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleCreateAnother}
                    className="flex-1 rounded-lg bg-gray-800 py-2 text-sm hover:bg-gray-700"
                  >
                    Create Another
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-semibold hover:bg-blue-500"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              /* Form state */
              <>
                <h2 className="mb-4 text-lg font-bold">New Interview</h2>
                <form onSubmit={handleCreate} className="flex flex-col gap-4">
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Candidate Name</label>
                    <input
                      type="text"
                      value={form.candidate_name}
                      onChange={e => setForm(f => ({ ...f, candidate_name: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Candidate Email</label>
                    <input
                      type="email"
                      value={form.candidate_email}
                      onChange={e => setForm(f => ({ ...f, candidate_email: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Job Title</label>
                    <input
                      type="text"
                      value={form.job_title}
                      onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-gray-400">Question Set</label>
                    <select
                      value={form.question_set_id}
                      onChange={e => setForm(f => ({ ...f, question_set_id: e.target.value }))}
                      required
                      className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select…</option>
                      {questionSets.map(qs => (
                        <option key={qs.id} value={qs.id}>
                          {qs.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  {modalError && <p className="text-sm text-red-400">{modalError}</p>}
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={closeModal}
                      className="flex-1 rounded-lg bg-gray-800 py-2 text-sm hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-50"
                    >
                      {submitting ? 'Creating…' : 'Create Invite'}
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
