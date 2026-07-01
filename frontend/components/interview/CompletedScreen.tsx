interface CompletedScreenProps {
  variant: 'success' | 'error'
  session: { candidateName: string; role: string } | null
  message?: string
}

export function CompletedScreen({ variant, session, message }: CompletedScreenProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-navy-950 px-6 text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: variant === 'success'
            ? 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(34,197,94,0.08) 0%, transparent 70%)'
            : 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(239,68,68,0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 flex max-w-md flex-col items-center gap-6 animate-fade-in">
        {variant === 'success' ? (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-green-500/15 border border-green-500/20">
              <svg className="h-10 w-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold">Interview Complete</h1>
              {session && (
                <p className="mt-3 text-slate-400">
                  Thank you, <span className="text-white font-medium">{session.candidateName}</span>.
                  Your <span className="text-white font-medium">{session.role}</span> interview has been recorded and will be reviewed by our team.
                </p>
              )}
            </div>
            <div className="glass-card w-full p-4 text-sm text-slate-400">
              You will hear back from the recruiter within 3–5 business days.
            </div>
            <p className="text-sm text-slate-600">You may now close this tab.</p>
          </>
        ) : (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
              <svg className="h-10 w-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold">Something went wrong</h1>
              <p className="mt-3 text-slate-400">
                {message ?? 'An unexpected error occurred during your interview.'}
              </p>
            </div>
            <p className="text-sm text-slate-400">
              Please contact your recruiter and mention this error. They can send you a new interview link.
            </p>
          </>
        )}

        <p className="text-xs text-slate-700">InterviewAI by Wohlig Transformations</p>
      </div>
    </div>
  )
}
