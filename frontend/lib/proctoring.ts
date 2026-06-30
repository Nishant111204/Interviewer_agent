import type { ProctoringEvent } from './capture'

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

export function attachProctoringListeners(
  onFlag: (event: ProctoringEvent) => void,
): () => void {
  let wasFullscreen = false

  function now() { return new Date().toISOString() }

  // Debounced — noisy events fire only after 500 ms of sustained state
  const handleVisibilityChange = debounce(() => {
    if (document.hidden) {
      try { onFlag({ type: 'tab_switch', ts: now() }) } catch (e) {
        console.error('[proctoring] tab_switch handler error:', e)
      }
    }
  }, 500)

  const handleWindowBlur = debounce(() => {
    try { onFlag({ type: 'window_blur', ts: now() }) } catch (e) {
      console.error('[proctoring] window_blur handler error:', e)
    }
  }, 500)

  // Direct — fire immediately, preventDefault to block action
  function handleCopy(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'copy_attempt', ts: now() }) } catch (e) {
      console.error('[proctoring] copy_attempt handler error:', e)
    }
  }

  function handlePaste(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'paste_attempt', ts: now() }) } catch (e) {
      console.error('[proctoring] paste_attempt handler error:', e)
    }
  }

  function handleFullscreenChange() {
    if (document.fullscreenElement !== null) {
      wasFullscreen = true
    } else if (wasFullscreen) {
      try { onFlag({ type: 'fullscreen_exit', ts: now() }) } catch (e) {
        console.error('[proctoring] fullscreen_exit handler error:', e)
      }
    }
  }

  function handleContextMenu(e: Event) {
    e.preventDefault()
    try { onFlag({ type: 'right_click', ts: now() }) } catch (e) {
      console.error('[proctoring] right_click handler error:', e)
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey
    const flagged =
      (ctrl && e.key === 'c') ||
      (ctrl && e.key === 'v') ||
      (ctrl && e.key === 'Tab') ||
      (e.altKey && e.key === 'Tab') ||
      e.key === 'F12' ||
      (ctrl && e.shiftKey && (e.key === 'I' || e.key === 'i'))

    if (flagged) {
      try {
        onFlag({
          type: 'keyboard_shortcut',
          ts: now(),
          key: e.key,
          ctrl: e.ctrlKey || e.metaKey,
          alt: e.altKey,
          shift: e.shiftKey,
        })
      } catch (err) {
        console.error('[proctoring] keyboard_shortcut handler error:', err)
      }
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('blur', handleWindowBlur)
  document.addEventListener('copy', handleCopy)
  document.addEventListener('paste', handlePaste)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('contextmenu', handleContextMenu)
  window.addEventListener('keydown', handleKeyDown)

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('blur', handleWindowBlur)
    document.removeEventListener('copy', handleCopy)
    document.removeEventListener('paste', handlePaste)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('contextmenu', handleContextMenu)
    window.removeEventListener('keydown', handleKeyDown)
  }
}
