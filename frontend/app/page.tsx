import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-navy-950 text-white">
      {/* Hero */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center bg-grid">
        {/* Radial glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(59,130,246,0.18) 0%, transparent 70%)' }}
        />

        <div className="relative z-10 flex flex-col items-center gap-6 animate-fade-in">
          {/* Logo mark */}
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600/20 border border-blue-500/30">
            <svg className="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
            </svg>
          </div>

          <div>
            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">InterviewAI</h1>
            <p className="mt-4 max-w-lg text-lg text-slate-400">
              AI-powered technical interviews. Fair, consistent, and insightful — at any scale.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/hr/login" className="btn-primary text-center min-w-[160px]">
              HR Portal →
            </Link>
            <a href="#how-it-works" className="btn-ghost text-center min-w-[160px]">
              How it works
            </a>
          </div>

          <p className="text-xs text-slate-600">By Wohlig Transformations</p>
        </div>
      </section>

      {/* Features */}
      <section id="how-it-works" className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-12 text-center text-3xl font-bold">Everything you need</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                ),
                title: 'Live AI Interviewer',
                desc: 'Gemini conducts real-time voice interviews, adapts follow-ups, and scores answers automatically.',
              },
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                ),
                title: 'Face Proctoring',
                desc: 'MediaPipe gaze tracking and face verification detect impersonation and distraction in real time.',
              },
              {
                icon: (
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                ),
                title: 'Instant Reports',
                desc: 'Per-question scores, suspicion analysis, and hire/reject recommendations ready the moment the interview ends.',
              },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="glass-card p-6 animate-slide-up">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/15 border border-blue-500/20">
                  <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    {icon}
                  </svg>
                </div>
                <h3 className="mb-2 font-semibold">{title}</h3>
                <p className="text-sm text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-8 text-center text-sm text-slate-600">
        © 2026 Wohlig Transformations. All rights reserved.
      </footer>
    </main>
  )
}
