'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../lib/supabase'

export default function HrLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (authError) setError(authError.message)
    else router.push('/hr')
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-navy-950 px-4">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(59,130,246,0.12) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 w-full max-w-sm animate-slide-up">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/20 border border-blue-500/30">
            <svg className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-xs font-medium tracking-widest text-slate-500 uppercase">Wohlig</p>
            <h1 className="text-xl font-bold">InterviewAI</h1>
          </div>
        </div>

        <div className="glass-card p-8">
          <h2 className="mb-6 text-lg font-semibold">Sign in to HR Portal</h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="hr@company.com"
                className="input-field"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="input-field"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary mt-1 w-full">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in…
                </span>
              ) : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
