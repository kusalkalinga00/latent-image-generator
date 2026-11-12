/**
 * The wait is an estimate, not a feed.
 *
 * Modal does not stream progress, so elapsed seconds are mapped onto a
 * percentage and a phase. The cap is deliberate: a bar at 100% while the image
 * has not arrived is a lie, and the image arriving is the only real completion
 * signal. Kept here, outside the component, so the curves can be tested.
 */
export function waitStep(elapsed: number, warmed: boolean) {
  if (warmed || elapsed >= 30) return 2
  if (elapsed >= 8) return 1
  return 0
}

export function waitProgress(elapsed: number, warmed: boolean) {
  if (warmed) return Math.min(92, 18 + (elapsed / 4) * 74)
  if (elapsed < 8) return (elapsed / 8) * 30
  if (elapsed < 30) return 30 + ((elapsed - 8) / 22) * 40
  return Math.min(92, 70 + ((elapsed - 30) / 20) * 22)
}
