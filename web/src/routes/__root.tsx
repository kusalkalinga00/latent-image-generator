import type { ErrorComponentProps } from '@tanstack/react-router'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { useEffect } from 'react'
import Footer from '../components/Footer'
import Header from '../components/Header'
import Toaster from '../components/Toaster'
import { pushToast } from '../lib/toast'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

function RootError({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    const message =
      error instanceof Error ? error.message : 'Something went wrong.'
    pushToast('error', message.slice(0, 180) || 'Something went wrong.')
  }, [error])

  return (
    <main className="studio-page">
      <section
        className="card"
        style={{ marginTop: '2rem', maxWidth: '28rem' }}
      >
        <h1 className="m-0 text-lg font-medium">Something went wrong</h1>
        <p className="m-0 text-sm leading-6 text-[var(--ink-soft)]">
          The page hit an unexpected error. You can try again.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="btn-quiet h-10 px-4 text-sm font-medium"
        >
          Try again
        </button>
      </section>
    </main>
  )
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Image Editor',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  errorComponent: RootError,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col font-sans antialiased [overflow-wrap:anywhere]">
        <Header />
        <div className="flex flex-col lg:flex-1">{children}</div>
        <Footer />
        <Toaster />
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
