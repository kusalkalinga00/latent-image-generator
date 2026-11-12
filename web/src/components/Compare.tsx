import { useState } from 'react'

/**
 * Wipe between the edit and the original, dragged across the image.
 *
 * The whole image is a range input, so it drags with the mouse, taps, and moves
 * with the arrow keys - no pointer-event maths and no inaccessible custom slider.
 */
export default function Compare({
  before,
  after,
}: {
  before: string
  after: string
}) {
  const [pos, setPos] = useState(54)

  return (
    <div className="compare">
      <img src={after} alt="Edited result" />
      <img
        src={before}
        alt=""
        aria-hidden="true"
        className="compare-overlay"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="compare-line" style={{ left: `${pos}%` }} />
      <span className="compare-grip" style={{ left: `${pos}%` }}>
        <svg
          viewBox="0 0 6 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M5 1L1 5l4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg
          viewBox="0 0 6 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M1 1l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="stage-tag">Before</span>
      <span className="stage-tag end">After</span>
      <input
        className="compare-range"
        type="range"
        min={0}
        max={100}
        value={pos}
        aria-label="Compare the original with the edit"
        onChange={(event) => setPos(Number(event.target.value))}
      />
    </div>
  )
}
