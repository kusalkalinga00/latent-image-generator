import ThemeToggle from './ThemeToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 bg-[var(--header-bg)] backdrop-blur-xl">
      <div className="page-wrap flex items-center justify-end py-3">
        <ThemeToggle />
      </div>
    </header>
  )
}
