'use client'

import { useState } from 'react'
import { PermissionCheck } from './PermissionCheck'
import SelfieCapture from '../SelfieCapture'

interface PreflightScreenProps {
  token: string
  session: { candidateName: string; role: string }
  descriptor: Float32Array | null
  stream: MediaStream | null
  onStreamGranted: (stream: MediaStream) => void
  onCapture: (descriptor: Float32Array) => void
  onBegin: () => void
}

type Step = 'permissions' | 'selfie' | 'ready'

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'permissions', label: 'Permissions' },
    { key: 'selfie', label: 'Verify Identity' },
    { key: 'ready', label: 'Begin' },
  ]
  const currentIdx = steps.findIndex(s => s.key === current)

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all ${
            i < currentIdx
              ? 'bg-blue-600 text-white'
              : i === currentIdx
              ? 'border-2 border-blue-500 text-blue-400'
              : 'border border-white/20 text-slate-600'
          }`}>
            {i < currentIdx ? '✓' : i + 1}
          </div>
          <span className={`text-xs ${i === currentIdx ? 'text-white' : 'text-slate-600'}`}>
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <div className={`h-px w-6 ${i < currentIdx ? 'bg-blue-600' : 'bg-white/10'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

export function PreflightScreen({
  token,
  session,
  descriptor,
  stream,
  onStreamGranted,
  onCapture,
  onBegin,
}: PreflightScreenProps) {
  const [step, setStep] = useState<Step>(stream ? 'selfie' : 'permissions')

  function handleStreamGranted(s: MediaStream) {
    onStreamGranted(s)
    setStep('selfie')
  }

  function handleCapture(d: Float32Array) {
    onCapture(d)
    setStep('ready')
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-navy-950 px-6 py-12">
      {/* Background glow */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: 'radial-gradient(ellipse 70% 40% at 50% 0%, rgba(59,130,246,0.1) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 flex w-full max-w-md flex-col gap-8 animate-fade-in">
        {/* Header */}
        <div className="text-center">
          <p className="text-xs font-medium tracking-widest text-slate-500 uppercase mb-1">InterviewAI</p>
          <h1 className="text-2xl font-bold">Welcome, {session.candidateName}</h1>
          <p className="mt-1 text-slate-400">{session.role} Interview</p>
        </div>

        {/* Step indicator */}
        <div className="flex justify-center">
          <StepIndicator current={step} />
        </div>

        {/* Step content */}
        <div className="glass-card p-8">
          {step === 'permissions' && (
            <PermissionCheck onGranted={handleStreamGranted} />
          )}

          {step === 'selfie' && stream && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <h2 className="font-semibold">Identity Verification</h2>
                <p className="mt-1 text-sm text-slate-400">
                  We need a clear photo of your face. Position yourself in the oval.
                </p>
              </div>
              <SelfieCapture
                stream={stream}
                sessionToken={token}
                onCapture={handleCapture}
              />
            </div>
          )}

          {step === 'ready' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/15 border border-green-500/20">
                <svg className="h-8 w-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-semibold text-green-400">All set!</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Your identity has been verified. The AI interviewer is ready. Find a quiet space and click Begin when ready.
                </p>
              </div>
              <ul className="w-full space-y-2 text-left text-sm text-slate-400">
                {['Speak clearly and at a normal pace', 'Look at the camera while answering', 'The interview takes approximately 20 minutes'].map(tip => (
                  <li key={tip} className="flex items-start gap-2">
                    <span className="mt-0.5 text-blue-400">·</span>
                    {tip}
                  </li>
                ))}
              </ul>
              <button
                onClick={onBegin}
                disabled={descriptor === null}
                className="btn-primary w-full text-lg py-4"
              >
                Begin Interview →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
