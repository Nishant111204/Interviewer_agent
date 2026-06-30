'use client'

interface CompletedScreenProps {
  variant: 'success' | 'error'
  session: { candidateName: string; role: string } | null
  message?: string
}

export function CompletedScreen({ variant, session, message }: CompletedScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-950 p-8 text-center text-white">
      {variant === 'success' ? (
        <>
          <svg
            className="h-16 w-16 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          </svg>
          <h1 className="text-3xl font-bold">Interview Complete</h1>
          {session && (
            <p className="max-w-md text-gray-400">
              Thank you, {session.candidateName}. Your {session.role} interview has been
              recorded and will be reviewed by our team.
            </p>
          )}
          <p className="text-sm text-gray-400">You may close this tab.</p>
        </>
      ) : (
        <>
          <svg
            className="h-16 w-16 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          </svg>
          <h1 className="text-3xl font-bold">Something went wrong</h1>
          {message && <p className="max-w-md text-gray-400">{message}</p>}
          <p className="text-sm text-gray-400">
            Please contact your recruiter if this issue persists.
          </p>
        </>
      )}
    </div>
  )
}
