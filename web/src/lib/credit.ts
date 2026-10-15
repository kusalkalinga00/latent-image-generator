import { createServerFn } from '@tanstack/react-start'

export interface CreditView {
  ok: boolean
  allowanceUsd?: number
  remainingUsd?: number
  coldEdits?: number
  warmEdits?: number
}

interface CreditBody {
  ok?: boolean
  allowance_usd?: number
  remaining_usd?: number
  cold_edits?: number
  warm_edits?: number
}

function usageUrl(apiUrl: string) {
  const override = process.env.IMAGE_EDITOR_USAGE_URL
  if (override) return override
  const derived = apiUrl.replace(/-api(?=\.)/, '-usage')
  return derived === apiUrl ? '' : derived
}

export const getCredit = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CreditView> => {
    const apiUrl = process.env.IMAGE_EDITOR_API_URL
    const tokenId = process.env.MODAL_PROXY_TOKEN_ID
    const tokenSecret = process.env.MODAL_PROXY_TOKEN_SECRET
    const url = apiUrl ? usageUrl(apiUrl) : ''

    if (!url || !tokenId || !tokenSecret) {
      console.error('Image editor credit check is not configured.')
      return { ok: false }
    }

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${tokenId}.${tokenSecret}` },
      })
      if (!response.ok) {
        console.error('Credit check failed:', response.status)
        return { ok: false }
      }
      const body = (await response.json()) as CreditBody
      if (
        !body.ok ||
        typeof body.remaining_usd !== 'number' ||
        typeof body.cold_edits !== 'number' ||
        typeof body.warm_edits !== 'number'
      ) {
        return { ok: false }
      }
      return {
        ok: true,
        allowanceUsd: body.allowance_usd,
        remainingUsd: body.remaining_usd,
        coldEdits: body.cold_edits,
        warmEdits: body.warm_edits,
      }
    } catch (error) {
      console.error('Credit check failed:', error)
      return { ok: false }
    }
  },
)
