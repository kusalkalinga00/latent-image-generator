export type ToastTone = 'error' | 'success' | 'info'

export interface ToastItem {
  id: string
  tone: ToastTone
  message: string
}

const MAX_TOASTS = 4
const EMPTY: ToastItem[] = []

let items: ToastItem[] = EMPTY
const listeners = new Set<() => void>()
const timers = new Map<string, number>()

function emit() {
  for (const listener of listeners) listener()
}

export function dismissToast(id: string) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  if (!items.some((item) => item.id === id)) return
  items = items.filter((item) => item.id !== id)
  emit()
}

export function pushToast(tone: ToastTone, message: string) {
  const id = crypto.randomUUID()
  const next = [...items, { id, tone, message }]
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) {
    const timer = timers.get(dropped.id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.delete(dropped.id)
    }
  }

  items = next.slice(-MAX_TOASTS)
  emit()

  const delay = tone === 'error' ? 8000 : 4200
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), delay),
  )
  return id
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getToasts() {
  return items
}

export function getServerToasts() {
  return EMPTY
}
