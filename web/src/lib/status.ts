import { createServerFn } from '@tanstack/react-start'

export interface StatusView {
  ok: boolean
  /** Renders running or queued behind the single GPU, including this one. */
  busy?: number
}

/**
 * The queue-depth endpoint beside `api`, `result`, and `usage`.
 *
 * Modal derives a web endpoint's URL from the function name, so the status
 * endpoint sits beside the API one; the override exists for a renamed app.
 */
function statusUrl(apiUrl: string): string {
  const override = process.env.IMAGE_EDITOR_STATUS_URL
  if (override) return override
  const derived = apiUrl.replace(/-api(?=\.|$)/, '-status')
  return derived === apiUrl ? '' : derived
}

export const getStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<StatusView> => {
    const apiUrl = process.env.IMAGE_EDITOR_API_URL
    const tokenId = process.env.MODAL_PROXY_TOKEN_ID
    const tokenSecret = process.env.MODAL_PROXY_TOKEN_SECRET
    const url = apiUrl ? statusUrl(apiUrl) : ''

    if (!url || !tokenId || !tokenSecret) {
      return { ok: false }
    }

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${tokenId}.${tokenSecret}` },
      })
      if (!response.ok) return { ok: false }

      const body = (await response.json()) as {
        ok?: boolean
        busy?: number
      }
      if (!body.ok || typeof body.busy !== 'number') return { ok: false }
      return { ok: true, busy: body.busy }
    } catch (error) {
      console.error('Queue status check failed:', error)
      return { ok: false }
    }
  },
)
