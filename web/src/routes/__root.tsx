import type { ErrorComponentProps } from '@tanstack/react-router'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { useEffect } from 'react'
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
    <main className="stage">
      <section className="empty">
        <h1>Something went wrong</h1>
        <p>The page hit an unexpected error. You can try again.</p>
        <div className="row">
          <button type="button" onClick={() => reset()} className="btn">
            Try again
          </button>
        </div>
      </section>
    </main>
  )
}

function NotFound() {
  return (
    <main className="stage">
      <section className="empty">
        <h1>Nothing here</h1>
        <p>That page does not exist. The editor is on the home page.</p>
        <div className="row">
          <a href="/" className="btn">
            Open the editor
          </a>
        </div>
      </section>
    </main>
  )
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        name: 'description',
        content:
          'Edit a photo by describing the change. Runs on a GPU on demand, and images are never stored.',
      },
      {
        name: 'theme-color',
        content: '#0a0b0d',
        media: '(prefers-color-scheme: dark)',
      },
      { title: 'Image Editor' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  errorComponent: RootError,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <div className="shell">
          <Header />
          {children}
        </div>
        <Toaster />
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
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
