import ThemeToggle from './ThemeToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 bg-[var(--header-bg)] backdrop-blur-xl">
      <div className="page-wrap flex items-center justify-between gap-3 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--ink)] text-[var(--bg-0)]">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
              <path d="M21 16l-5.5-5.5L7 19" />
            </svg>
          </span>
          <span className="truncate text-[15px] font-medium tracking-tight text-[var(--ink)]">
            Image Editor
          </span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  )
}
