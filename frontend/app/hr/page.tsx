// frontend/app/hr/page.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
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

const JOB_ROLES = ['SDE', 'Data Analyst', 'Business Analyst', 'GenAI', 'UI/UX Designer', 'Custom']
const EXPERIENCE_OPTIONS = [
  { value: 'Fresher', label: 'Fresher' },
  { value: '1', label: '1 year' },
  { value: '2-3', label: '2–3 years' },
  { value: '3-5', label: '3–5 years' },
  { value: '5+', label: '5+ years' },
]

interface CreateForm {
  candidate_name: string
  candidate_email: string
  job_title: string
  job_role: string
  job_role_custom: string
  experience_years: string
  linkedin_url: string
  jd_mode: 'text' | 'pdf'
  jd_text: string
  jd_file: File | null
  resume_mode: 'text' | 'pdf'
  resume_text: string
  resume_file: File | null
  use_question_set: boolean
  question_set_id: string
  custom_instructions: string
}

const EMPTY_FORM: CreateForm = {
  candidate_name: '', candidate_email: '', job_title: '',
  job_role: '', job_role_custom: '', experience_years: '',
  linkedin_url: '',
  jd_mode: 'text', jd_text: '', jd_file: null,
  resume_mode: 'text', resume_text: '', resume_file: null,
  use_question_set: true, question_set_id: '',
  custom_instructions: '',
}

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

function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full transition-colors ${current === 1 ? 'bg-blue-500' : 'bg-white/20'}`} />
      <span className={`h-2 w-2 rounded-full transition-colors ${current === 2 ? 'bg-blue-500' : 'bg-white/20'}`} />
    </div>
  )
}

function DocField({
  label, mode, onModeChange, text, onTextChange, file, onFileChange,
}: {
  label: string
  mode: 'text' | 'pdf'
  onModeChange: (m: 'text' | 'pdf') => void
  text: string
  onTextChange: (v: string) => void
  file: File | null
  onFileChange: (f: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-sm text-slate-400">{label}</label>
        <div className="flex rounded-lg border border-white/10 overflow-hidden text-xs">
          {(['text', 'pdf'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={`px-2.5 py-1 font-medium transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {m === 'text' ? 'Paste Text' : 'Upload PDF'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'text' ? (
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          rows={4}
          placeholder={`Paste ${label.toLowerCase()} here…`}
          className="input-field resize-none"
        />
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/20 bg-white/[0.03] p-4 text-center hover:border-blue-500/40 hover:bg-blue-500/5 transition-all"
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={e => onFileChange(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-300">{file.name}</span>
              <span className="text-xs text-slate-500">({(file.size / 1024).toFixed(0)} KB)</span>
              <button
                type="button"
                onClick={ev => { ev.stopPropagation(); if (inputRef.current) inputRef.current.value = ''; onFileChange(null) }}
                className="text-slate-500 hover:text-red-400 transition-colors"
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <svg className="h-6 w-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-xs text-slate-500">Click to upload PDF (max 10 MB)</p>
            </>
          )}
        </div>
      )}
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
  const [step, setStep] = useState<1 | 2>(1)
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
      .catch((err: unknown) => { console.error('[hr] failed to load:', err); setLoading(false) })
  }, [accessToken])

  const filteredQuestionSets = questionSets.filter(qs => {
    const role = form.job_role === 'Custom' ? form.job_role_custom : form.job_role
    return !role || qs.role.toLowerCase().includes(role.toLowerCase())
  })

  function setF<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function validateStep1(): string | null {
    if (!form.candidate_name.trim()) return 'Candidate name is required'
    if (!form.candidate_email.trim()) return 'Candidate email is required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.candidate_email)) return 'Please enter a valid email address'
    if (!form.job_title.trim()) return 'Job title is required'
    if (!form.job_role) return 'Job role is required'
    if (form.job_role === 'Custom' && !form.job_role_custom.trim()) return 'Please enter the custom job role'
    if (!form.experience_years) return 'Experience level is required'
    return null
  }

  function handleNext() {
    const err = validateStep1()
    if (err) { setModalError(err); return }
    setModalError(null)
    setStep(2)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (form.use_question_set && !form.question_set_id) {
      setModalError('Please select a question set, or turn off the question bank toggle')
      return
    }

    // Enforce 10 MB limit client-side
    for (const file of [form.jd_file, form.resume_file]) {
      if (file && file.size > 10 * 1024 * 1024) {
        setModalError('PDF files must be under 10 MB')
        return
      }
    }

    setSubmitting(true)
    setModalError(null)

    const fd = new FormData()
    fd.append('candidate_name', form.candidate_name)
    fd.append('candidate_email', form.candidate_email)
    fd.append('job_title', form.job_title)
    fd.append('job_role', form.job_role === 'Custom' ? form.job_role_custom : form.job_role)
    fd.append('experience_years', form.experience_years)
    if (form.linkedin_url) fd.append('linkedin_url', form.linkedin_url)
    fd.append('use_question_set', String(form.use_question_set))
    if (form.use_question_set && form.question_set_id) fd.append('question_set_id', form.question_set_id)
    if (form.jd_mode === 'pdf' && form.jd_file) fd.append('jd_file', form.jd_file)
    else if (form.jd_mode === 'text' && form.jd_text) fd.append('jd_text', form.jd_text)
    if (form.resume_mode === 'pdf' && form.resume_file) fd.append('resume_file', form.resume_file)
    else if (form.resume_mode === 'text' && form.resume_text) fd.append('resume_text', form.resume_text)
    if (form.custom_instructions) fd.append('custom_instructions', form.custom_instructions)

    try {
      const res = await fetch(`${REST_BASE}/api/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd,
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setModalError(body.error ?? 'Failed to create session')
        return
      }
      const { id, token } = (await res.json()) as { id: string; token: string }
      setInviteToken(token)
      setSessions(prev => [{
        id,
        candidate_name: form.candidate_name,
        candidate_email: form.candidate_email,
        job_title: form.job_title,
        status: 'pending',
        overall_score: null,
        created_at: new Date().toISOString(),
      }, ...prev])
    } catch { setModalError('Network error') }
    finally { setSubmitting(false) }
  }

  function closeModal() {
    setShowModal(false)
    setInviteToken(null)
    setModalError(null)
    setForm(EMPTY_FORM)
    setStep(1)
  }

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
            <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">+ New Interview</button>
            <button onClick={() => supabase.auth.signOut()} className="btn-ghost py-2 text-sm">Logout</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total Sessions" value={sessions.length} />
          <StatCard label="In Progress" value={inProgress} sub={inProgress > 0 ? 'Active now' : 'None active'} />
          <StatCard label="Completed" value={completed} />
          <StatCard label="Avg Score" value={avgScore} sub={scores.length > 0 ? `from ${scores.length} interviews` : 'No scores yet'} />
        </div>

        <div className="glass-card overflow-hidden">
          <div className="border-b border-white/8 px-5 py-4">
            <h2 className="font-semibold">Interview Sessions</h2>
          </div>
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-slate-500">No sessions yet.</p>
              <button onClick={() => setShowModal(true)} className="btn-primary py-2 text-sm">Create your first interview</button>
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

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-2xl p-6 animate-slide-up max-h-[90vh] overflow-y-auto">
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
                  <button onClick={() => { setInviteToken(null); setModalError(null); setForm(EMPTY_FORM); setStep(1) }} className="btn-ghost flex-1 py-2 text-sm">Create Another</button>
                  <button onClick={closeModal} className="btn-primary flex-1 py-2 text-sm">Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-lg font-bold">
                    {step === 1 ? 'New Interview — Candidate Details' : 'New Interview — Interview Context'}
                  </h2>
                  <StepDots current={step} />
                </div>

                {step === 1 ? (
                  <div className="flex flex-col gap-4">
                    {([
                      { label: 'Candidate Name', key: 'candidate_name', type: 'text', placeholder: 'Jane Smith' },
                      { label: 'Candidate Email', key: 'candidate_email', type: 'email', placeholder: 'jane@example.com' },
                      { label: 'Job Title', key: 'job_title', type: 'text', placeholder: 'Senior Frontend Developer' },
                    ] as const).map(field => (
                      <div key={field.key}>
                        <label className="mb-1.5 block text-sm text-slate-400">{field.label} *</label>
                        <input
                          type={field.type}
                          value={form[field.key]}
                          onChange={e => setF(field.key, e.target.value)}
                          required
                          placeholder={field.placeholder}
                          className="input-field"
                        />
                      </div>
                    ))}

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Job Role *</label>
                      <select
                        value={form.job_role}
                        onChange={e => setF('job_role', e.target.value)}
                        required
                        className="input-field"
                      >
                        <option value="">Select role…</option>
                        {JOB_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      {form.job_role === 'Custom' && (
                        <input
                          type="text"
                          value={form.job_role_custom}
                          onChange={e => setF('job_role_custom', e.target.value)}
                          placeholder="Enter custom role name…"
                          className="input-field mt-2"
                        />
                      )}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Experience Level *</label>
                      <select
                        value={form.experience_years}
                        onChange={e => setF('experience_years', e.target.value)}
                        required
                        className="input-field"
                      >
                        <option value="">Select level…</option>
                        {EXPERIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">LinkedIn Profile URL <span className="text-slate-600">(optional)</span></label>
                      <input
                        type="url"
                        value={form.linkedin_url}
                        onChange={e => setF('linkedin_url', e.target.value)}
                        placeholder="https://linkedin.com/in/username"
                        className="input-field"
                      />
                    </div>

                    {modalError && (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button type="button" onClick={closeModal} className="btn-ghost flex-1 py-2 text-sm">Cancel</button>
                      <button type="button" onClick={handleNext} className="btn-primary flex-1 py-2 text-sm">Next →</button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleCreate} className="flex flex-col gap-5">
                    <DocField
                      label="Job Description"
                      mode={form.jd_mode}
                      onModeChange={m => setF('jd_mode', m)}
                      text={form.jd_text}
                      onTextChange={v => setF('jd_text', v)}
                      file={form.jd_file}
                      onFileChange={f => setF('jd_file', f)}
                    />

                    <DocField
                      label="Candidate Resume"
                      mode={form.resume_mode}
                      onModeChange={m => setF('resume_mode', m)}
                      text={form.resume_text}
                      onTextChange={v => setF('resume_text', v)}
                      file={form.resume_file}
                      onFileChange={f => setF('resume_file', f)}
                    />

                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">Use DB Question Bank</p>
                          <p className="text-xs text-slate-500 mt-0.5">Provides competency anchors to the AI interviewer</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setF('use_question_set', !form.use_question_set)}
                          className={`relative h-6 w-11 rounded-full transition-colors ${form.use_question_set ? 'bg-blue-600' : 'bg-white/20'}`}
                        >
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${form.use_question_set ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      {form.use_question_set && (
                        <div>
                          <label className="mb-1.5 block text-xs text-slate-400">Question Set (filtered by job role)</label>
                          <select
                            value={form.question_set_id}
                            onChange={e => setF('question_set_id', e.target.value)}
                            className="input-field text-sm"
                          >
                            <option value="">Select a question set…</option>
                            {filteredQuestionSets.map(qs => <option key={qs.id} value={qs.id}>{qs.role}</option>)}
                          </select>
                          {filteredQuestionSets.length === 0 && (
                            <p className="mt-1.5 text-xs text-amber-400">No question sets found for this role. Turn off the toggle for a fully AI-generated interview.</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm text-slate-400">Custom Instructions <span className="text-slate-600">(optional)</span></label>
                      <textarea
                        value={form.custom_instructions}
                        onChange={e => setF('custom_instructions', e.target.value)}
                        rows={3}
                        placeholder="Any extra guidance for the interviewer AI…"
                        className="input-field resize-none"
                      />
                    </div>

                    {modalError && (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{modalError}</div>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button type="button" onClick={() => { setStep(1); setModalError(null) }} className="btn-ghost flex-1 py-2 text-sm">← Back</button>
                      <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2 text-sm">
                        {submitting ? 'Creating…' : 'Create & Send Invite'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
