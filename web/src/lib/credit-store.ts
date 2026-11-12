import { getCredit } from '#/lib/credit'
import type { CreditView } from '#/lib/credit'

/**
 * Credit, shared between the header chip and the editor.
 *
 * The chip lives in the header and the edit happens in the route, so the value
 * needs somewhere to live outside React: a tiny external store in the same shape
 * as `lib/toast`. `refreshCredit()` is called after an edit lands, which is the
 * only moment the number can move - a fetch per render would hammer the Modal
 * usage endpoint for nothing.
 *
 * The usage endpoint takes a few seconds (it is a server function calling Modal),
 * so the last known value is cached: the chip shows a real number immediately and
 * corrects itself when the refresh lands, instead of displaying an empty pill for
 * the first few seconds of every visit.
 */

const CACHE_KEY = 'image-editor:credit'
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Matches MIN_CREDIT_USD in modal_app/src/modal_app/app.py.
 *
 * The chip stays public: this is the free tier, and the budget is part of the
 * product. Below this the server refuses new renders, so the composer says so
 * before the user waits for a round trip.
 */
export const MIN_CREDIT_USD = 1

function readCache(): CreditView | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw) as {
      at?: number
      credit?: CreditView
    } | null
    if (!cached) return null
    if (!cached.credit?.ok || typeof cached.credit.remainingUsd !== 'number')
      return null
    if (!cached.at || Date.now() - cached.at > CACHE_MAX_AGE_MS) return null
    return cached.credit
  } catch {
    return null
  }
}

function writeCache(credit: CreditView) {
  if (typeof window === 'undefined' || !credit.ok) return
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), credit }),
    )
  } catch {
    // Private browsing or a full quota: the cached value is an optimisation, not
    // a requirement, so failing to store it is not an error worth surfacing.
  }
}

let current: CreditView | null = readCache()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeCredit(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCreditSnapshot() {
  return current
}

export function getServerCreditSnapshot(): CreditView | null {
  return null
}

let inFlight: Promise<void> | null = null

export function refreshCredit(): Promise<void> {
  // Two callers (mount and post-edit) should share one request rather than
  // racing, so the later one cannot overwrite a fresher number with an older one.
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const next = await getCredit()
      // A failed refresh keeps the last good number: showing yesterday's balance
      // is closer to the truth than showing nothing at all.
      if (next.ok || current === null) current = next
      writeCache(next)
    } catch {
      if (current === null) current = { ok: false }
    } finally {
      inFlight = null
    }
    emit()
  })()

  return inFlight
}
