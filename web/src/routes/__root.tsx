import type { ErrorComponentProps } from '@tanstack/react-router'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { useEffect } from 'react'
import Header from '../components/Header'
import Toaster from '../components/Toaster'
import { BRAND, SOCIAL_IMAGE, SOCIAL_IMAGE_ALT } from '../lib/brand'
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
        <p>That page does not exist. The studio is on the home page.</p>
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
      { title: BRAND.title },
      { name: 'description', content: BRAND.description },
      // theme-color lives in the shell, not here: two entries share one `name`,
      // so the head de-duplicates them and keeps only the last — which painted
      // light chrome over the dark theme.

      // Open Graph. Without these a shared link shows a bare URL: X, Slack and
      // iMessage all read these tags and none of them guess.
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: BRAND.name },
      { property: 'og:title', content: BRAND.title },
      { property: 'og:description', content: BRAND.description },
      { property: 'og:url', content: BRAND.url },
      // Absolute on purpose: scrapers do not resolve relative image paths.
      { property: 'og:image', content: SOCIAL_IMAGE },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: SOCIAL_IMAGE_ALT },

      // Twitter/X falls back to og:* but a large card needs saying out loud.
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: BRAND.title },
      { name: 'twitter:description', content: BRAND.description },
      { name: 'twitter:image', content: SOCIAL_IMAGE },
      { name: 'twitter:image:alt', content: SOCIAL_IMAGE_ALT },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'canonical', href: BRAND.url },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
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
        <meta
          name="theme-color"
          content="#0a0b0d"
          media="(prefers-color-scheme: dark)"
        />
        <meta
          name="theme-color"
          content="#fafafa"
          media="(prefers-color-scheme: light)"
        />
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
