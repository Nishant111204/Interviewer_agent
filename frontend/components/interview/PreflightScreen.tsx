'use client'

import SelfieCapture from '../SelfieCapture'

interface PreflightScreenProps {
  token: string
  session: { candidateName: string; role: string }
  descriptor: Float32Array | null
  onCapture: (descriptor: Float32Array) => void
  onBegin: () => void
}

export function PreflightScreen({
  token,
  session,
  descriptor,
  onCapture,
  onBegin,
}: PreflightScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Hello, {session.candidateName}</h1>
        <p className="mt-1 text-gray-400">Role: {session.role}</p>
      </div>

      <p className="max-w-sm text-center text-sm text-gray-400">
        Before we begin, we need a clear photo of your face for identity verification.
      </p>

      <SelfieCapture sessionToken={token} onCapture={onCapture} />

      <button
        onClick={onBegin}
        disabled={descriptor === null}
        className="mt-2 rounded-lg bg-blue-600 px-8 py-3 font-semibold transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Begin Interview
      </button>
    </div>
  )
}
