import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Mode } from '#/lib/edit'
import { waitProgress, waitStep } from '#/lib/wait'

const WAIT_PHASES = {
  edit: ['Starting a GPU', 'Loading the model', 'Editing'],
  generate: ['Starting a GPU', 'Loading the model', 'Painting'],
} as const

const DOT_COLS = 26
const DOT_ROWS = 15
const DOT_TOTAL = DOT_COLS * DOT_ROWS

/**
 * The order dots light up in.
 *
 * A fixed shuffle, not Math.random(): the field has to look scattered while every
 * tick keeps the same arrangement, or the picture reshuffles itself ten times a
 * second and reads as noise instead of progress.
 */
const DOT_ORDER = (() => {
  const order = Array.from({ length: DOT_TOTAL }, (_, i) => i)
  let seed = 7
  const next = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    const swap = order[i]
    order[i] = order[j]
    order[j] = swap
  }
  return order
})()

const Dots = memo(function Dots({
  cols,
  filled,
}: {
  cols: number
  filled: number
}) {
  return (
    <>
      {Array.from({ length: cols * DOT_ROWS }, (_, index) => {
        const rank = DOT_ORDER[index % DOT_ORDER.length]
        return (
          <i
            key={index}
            aria-hidden="true"
            className={rank < filled ? 'on' : undefined}
          />
        )
      })}
    </>
  )
})

/**
 * The wait, drawn as a field of dots that fills in.
 *
 * A spinner says something is happening; this says how much. It also gives the
 * cold start somewhere to live: the caption names the phase, so 30 seconds of
 * loading reads as a step rather than a stall.
 */
export default function Sketching({
  warmed,
  mode,
  ahead,
}: {
  warmed: boolean
  mode: Mode
  ahead: number
}) {
  // The timer lives here, not in App: a 4 fps tick should repaint the sketch,
  // not the composer, the stage, and every attachment thumbnail.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 250)
    return () => clearInterval(id)
  }, [])

  const phase = waitStep(elapsed, warmed)
  const progress = Math.round(waitProgress(elapsed, warmed))
  const label = WAIT_PHASES[mode][phase]

  // The grid used to be 26 columns flat, which is 429px of dots and gap: wider
  // than a 375px phone, and it dragged the whole thread — and the prompt bubble
  // in it — off the right edge. The column count now comes from the space that
  // exists, and the dots rendered follow it, so the field always fits and the
  // percentage still means what it says.
  // Start conservative: a wide first guess is what overflowed the phone before
  // the measurement lands, and the measure happens in a layout effect anyway.
  const [cols, setCols] = useState(12)
  const blockRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = blockRef.current
    if (!el) return
    const fit = () => {
      // --dot and --gap are declared on .matrix, not on the block, and the width
      // that matters is the thread's — the block is stretched to it but the grid
      // inside is what used to push it wide.
      const grid = el.querySelector('.matrix') ?? el
      const styles = getComputedStyle(grid)
      const dot = Number.parseFloat(styles.getPropertyValue('--dot')) || 4
      const gap = Number.parseFloat(styles.getPropertyValue('--gap')) || 15
      const width = (el.parentElement ?? el).clientWidth
      setCols(Math.max(6, Math.floor((width + gap) / (dot + gap))))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el.parentElement ?? el)
    return () => observer.disconnect()
  }, [])

  const total = cols * DOT_ROWS
  const filled = Math.round((total * progress) / 100)

  return (
    <div className="matrix-block" ref={blockRef}>
      <p className="matrix-caption">
        {label} · {elapsed.toFixed(0)}s
        {ahead > 0 && <span className="matrix-queue"> · {ahead} ahead</span>}
      </p>
      <div className="matrix-field">
        <div
          className="matrix"
          style={{ '--cols': cols } as CSSProperties}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`${label}, ${progress}%`}
        >
          <Dots cols={cols} filled={filled} />
        </div>
        <span className="matrix-pct">{progress}%</span>
      </div>
    </div>
  )
}
