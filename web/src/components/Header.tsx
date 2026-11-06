import CreditChip from './CreditChip'
import ThemeToggle from './ThemeToggle'
import { BRAND } from '../lib/brand'

/**
 * Chrome, floated over the canvas rather than given a bar of its own.
 *
 * The old header was 56px of solid strip at the top of an 800px viewport, spent on
 * a wordmark and a credit number. Both still matter, so both are here - at the
 * edge of the picture instead of above it.
 */
export default function Header() {
  return (
    <div className="top">
      <div className="brand">
        <i aria-hidden="true" />
        {BRAND.wordmark}
      </div>
      <div className="top-right">
        <CreditChip />
        <ThemeToggle />
      </div>
    </div>
  )
}
