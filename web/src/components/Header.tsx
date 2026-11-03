import CreditChip from './CreditChip'
import ThemeToggle from './ThemeToggle'

export default function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <i aria-hidden="true" />
        image<span>editor</span>
      </div>
      <div className="topbar-right">
        <CreditChip />
        <ThemeToggle />
      </div>
    </header>
  )
}
