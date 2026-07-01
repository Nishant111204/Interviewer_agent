'use client'

import { useState, useCallback } from 'react'

interface PermissionCheckProps {
  onGranted: (stream: MediaStream) => void
}

type State = 'idle' | 'requesting' | 'denied' | 'error'

function isChrome() {
  return typeof navigator !== 'undefined' && /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)
}

function isSafari() {
  return typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
}

export function PermissionCheck({ onGranted }: PermissionCheckProps) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const requestPermissions = useCallback(async () => {
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      onGranted(stream)
    } catch (err) {
      const error = err as Error
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setState('denied')
      } else {
        setState('error')
        setErrorMsg(error.message || 'Could not access camera or microphone.')
      }
    }
  }, [onGranted])

  if (state === 'idle') {
    return (
      <div className="flex flex-col items-center gap-6 text-center animate-fade-in">
        <div className="flex gap-4">
          {/* Camera icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600/15 border border-blue-500/20">
            <svg className="h-7 w-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
            </svg>
          </div>
          {/* Mic icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600/15 border border-blue-500/20">
            <svg className="h-7 w-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
            </svg>
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold">Camera & Microphone Access</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-400">
            We need your camera to verify your identity and monitor the interview, and your microphone to hear your answers.
          </p>
        </div>

        <button onClick={requestPermissions} className="btn-primary min-w-[200px]">
          Allow Camera & Mic
        </button>

        <p className="text-xs text-slate-600">
          A browser permission prompt will appear. Click &ldquo;Allow&rdquo; to continue.
        </p>
      </div>
    )
  }

  if (state === 'requesting') {
    return (
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-blue-500" />
        <p className="text-slate-400">Waiting for browser permission…</p>
        <p className="text-xs text-slate-600">Check for a prompt at the top of your browser window.</p>
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="flex flex-col items-center gap-5 text-center animate-fade-in max-w-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
          <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-red-400">Permission Denied</h2>
          <p className="mt-2 text-sm text-slate-400">
            You blocked camera or microphone access. To fix this:
          </p>
        </div>

        <div className="w-full rounded-xl border border-white/8 bg-white/[0.03] p-4 text-left text-sm text-slate-300 space-y-2">
          {isChrome() && (
            <>
              <p className="font-medium text-white">Chrome:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click the lock icon in your address bar</li>
                <li>Set Camera and Microphone to &ldquo;Allow&rdquo;</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
          {isSafari() && (
            <>
              <p className="font-medium text-white">Safari:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Go to Safari → Settings for This Website</li>
                <li>Set Camera and Microphone to &ldquo;Allow&rdquo;</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
          {!isChrome() && !isSafari() && (
            <>
              <p className="font-medium text-white">To fix:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click the camera/lock icon in your address bar</li>
                <li>Allow camera and microphone for this site</li>
                <li>Refresh the page</li>
              </ol>
            </>
          )}
        </div>

        <button onClick={requestPermissions} className="btn-ghost">
          Try Again
        </button>
      </div>
    )
  }

  // error state
  return (
    <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/20">
        <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
      </div>
      <div>
        <h2 className="text-xl font-semibold">Camera Error</h2>
        <p className="mt-2 text-sm text-slate-400">{errorMsg ?? 'Could not access your camera or microphone.'}</p>
        <p className="mt-1 text-xs text-slate-600">Make sure no other app is using your camera, then try again.</p>
      </div>
      <button onClick={requestPermissions} className="btn-primary">
        Try Again
      </button>
    </div>
  )
}
