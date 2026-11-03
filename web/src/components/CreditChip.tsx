import { useEffect, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import {
  getCreditSnapshot,
  getServerCreditSnapshot,
  refreshCredit,
  subscribeCredit,
} from '#/lib/credit-store'

function money(amount: number) {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })
}

/**
 * Remaining monthly credit, as one chip.
 *
 * It used to be a card above the editor with a meter, two badges and a skeleton
 * - the largest thing on the page, before the user had done anything. It is a
 * budget, not the task: a chip is enough, and the edit count answers the only
 * question worth asking ("how many more edits is that?").
 */
export default function CreditChip() {
  const credit = useSyncExternalStore(
    subscribeCredit,
    getCreditSnapshot,
    getServerCreditSnapshot,
  )

  // Always revalidate on mount, even with a cached value on screen.
  useEffect(() => {
    void refreshCredit()
  }, [])

  // No number yet and nothing cached: show nothing rather than an empty pill,
  // which reads as broken. The chip appears when there is something to say.
  if (credit === null || !credit.ok) return null

  const allowance = credit.allowanceUsd ?? 30
  const remaining = Math.max(0, credit.remainingUsd ?? 0)
  const used = allowance > 0 ? (allowance - remaining) / allowance : 0
  const edits = (credit.warmEdits ?? 0).toLocaleString('en-US')

  return (
    <div
      className="credit-chip"
      title={`${money(remaining)} of ${money(allowance)} left this month - roughly ${edits} more edits`}
    >
      <span
        className="credit-ring"
        style={{ '--used': Math.min(100, used * 100) } as CSSProperties}
        aria-hidden="true"
      />
      <span>
        <b>{money(remaining)}</b> left
      </span>
      <span className="dim">· ≈{edits} edits</span>
    </div>
  )
}
