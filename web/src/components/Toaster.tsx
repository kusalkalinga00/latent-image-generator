import { useEffect, useSyncExternalStore } from 'react'
import type { ToastTone } from '#/lib/toast'
import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
} from '#/lib/toast'

export default function Toaster() {
  const toasts = useSyncExternalStore(
    subscribeToasts,
    getToasts,
    getServerToasts,
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || toasts.length === 0) return
      dismissToast(toasts[toasts.length - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toasts])

  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <ToastIcon tone={toast.tone} />
          <p className="toast-message">{toast.message}</p>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss message"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="toast-icon">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </svg>
    )
  }

  if (tone === 'info') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="toast-icon">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6" />
        <path d="M12 8h.01" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="toast-icon">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  )
}
