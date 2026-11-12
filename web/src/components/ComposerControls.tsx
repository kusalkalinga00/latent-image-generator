import { useEffect, useRef, useState } from 'react'
import { ASPECT_LABELS } from '#/lib/edit'
import type { Aspect } from '#/lib/edit'

/**
 * The transparency control, in two dresses: an icon inside the pill on wide
 * screens, a labelled chip in its own row on phones, where a third icon beside a
 * short field was both crowded and indistinguishable from the shape control next
 * to it.
 *
 * It asks the model for an alpha channel rather than cutting anything out, so it
 * is labelled for what it produces.
 */
export function TransparentControl({
  on,
  chip,
  disabled,
  title,
  onToggle,
}: {
  on: boolean
  chip: boolean
  disabled: boolean
  title: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={`${chip ? 'chip-toggle' : 'icon-toggle'}${on ? ' is-on' : ''}`}
      onClick={onToggle}
      aria-pressed={on}
      aria-label="Transparent background"
      title={title}
      disabled={disabled}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="3.6"
          y="3.6"
          width="16.8"
          height="16.8"
          rx="3.4"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M6.2 6.2h5.8v5.8H6.2zM12 12h5.8v5.8H12z" fill="currentColor" />
      </svg>
      {chip && <span>Transparent</span>}
    </button>
  )
}

const ASPECT_OPTIONS = Object.keys(ASPECT_LABELS) as Aspect[]

export function ShapeControl({
  value,
  onChange,
}: {
  value: Aspect
  onChange: (next: Aspect) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  // A native <select> cannot be styled and its popup is placed by the OS — on a
  // phone it landed over the headline, far from the control that opened it. This
  // is the same list, drawn where it belongs.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Opening moves focus into the list, where the arrow keys take over.
  useEffect(() => {
    if (!open) return
    optionRefs.current[ASPECT_OPTIONS.indexOf(value)]?.focus()
  }, [open, value])

  const choose = (next: Aspect) => {
    onChange(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="shape" ref={wrap}>
      <button
        ref={triggerRef}
        type="button"
        className="shape-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Image shape: ${ASPECT_LABELS[value]}`}
        onClick={() => setOpen((was) => !was)}
      >
        <span>{ASPECT_LABELS[value]}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul className="shape-menu" role="listbox" aria-label="Image shape">
          {ASPECT_OPTIONS.map((option, index) => (
            <li key={option} role="presentation">
              <button
                ref={(node) => {
                  optionRefs.current[index] = node
                }}
                type="button"
                role="option"
                aria-selected={option === value}
                tabIndex={option === value ? 0 : -1}
                className={`shape-choice${option === value ? ' is-on' : ''}`}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  const focusOption = (nextIndex: number) => {
                    event.preventDefault()
                    onChange(ASPECT_OPTIONS[nextIndex])
                    optionRefs.current[nextIndex]?.focus()
                  }
                  if (event.key === 'ArrowDown') {
                    focusOption((index + 1) % ASPECT_OPTIONS.length)
                  } else if (event.key === 'ArrowUp') {
                    focusOption(
                      (index - 1 + ASPECT_OPTIONS.length) %
                        ASPECT_OPTIONS.length,
                    )
                  } else if (event.key === 'Home') {
                    focusOption(0)
                  } else if (event.key === 'End') {
                    focusOption(ASPECT_OPTIONS.length - 1)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setOpen(false)
                    triggerRef.current?.focus()
                  }
                }}
              >
                <ShapeGlyph aspect={option} />
                <span>{ASPECT_LABELS[option]}</span>
                {option === value && (
                  <svg
                    className="shape-check"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 12.5l4.5 4.5L19 7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The aspect, drawn to scale — a word says "Wide", this shows how wide. */
function ShapeGlyph({ aspect }: { aspect: Aspect }) {
  const [w, h] = aspect.split(':').map(Number)
  const long = 14
  const width = w >= h ? long : (long * w) / h
  const height = h >= w ? long : (long * h) / w
  return (
    <svg
      className="shape-glyph"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x={(16 - width) / 2}
        y={(16 - height) / 2}
        width={width}
        height={height}
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}
