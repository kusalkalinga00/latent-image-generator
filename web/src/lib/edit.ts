import { createServerFn } from '@tanstack/react-start'

/**
 * The one place that talks to Modal.
 *
 * The Modal proxy token is read from `process.env` *inside the handler*, not at
 * module scope, and deliberately without a VITE_ prefix so it is never inlined
 * into browser code. Everything here runs on the server: the browser posts an
 * image to this function and never learns the endpoint or the credential.
 *
 * That is the whole reason the Gradio UI was dropped. A UI living inside the GPU
 * service has to authenticate its own users; a UI that proxies through a server
 * does not, because the credential never leaves the server.
 */

export interface EditInput {
  imagesBase64: string[]
  prompt: string
  steps: number
  seed: number
}

export interface EditOutput {
  ok: boolean
  imageBase64?: string
  seconds?: number
  steps?: number
  error?: string
}

export const editImage = createServerFn({ method: 'POST' })
  .validator((data: EditInput) => data)
  .handler(async ({ data }): Promise<EditOutput> => {
    const apiUrl = process.env.IMAGE_EDITOR_API_URL
    const tokenId = process.env.MODAL_TOKEN_ID
    const tokenSecret = process.env.MODAL_TOKEN_SECRET

    if (!apiUrl || !tokenId || !tokenSecret) {
      const missing = [
        !apiUrl && 'IMAGE_EDITOR_API_URL',
        !tokenId && 'MODAL_TOKEN_ID',
        !tokenSecret && 'MODAL_TOKEN_SECRET',
      ].filter(Boolean)
      return {
        ok: false,
        error: `Server is not configured. Missing: ${missing.join(', ')}`,
      }
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Modal's proxy auth accepts the id.secret pair as a bearer token.
          Authorization: `Bearer ${tokenId}.${tokenSecret}`,
        },
        body: JSON.stringify({
          image_b64: data.imagesBase64,
          prompt: data.prompt,
          steps: data.steps,
          seed: data.seed,
        }),
      })

      const text = await response.text()

      if (!response.ok) {
        // 401 here means the proxy token is wrong, not that the model failed.
        return {
          ok: false,
          error: `Modal returned HTTP ${response.status}. ${text.slice(0, 300)}`,
        }
      }

      const body = JSON.parse(text)
      if (!body.ok) {
        return { ok: false, error: body.error ?? 'The model returned an unknown error.' }
      }

      return {
        ok: true,
        imageBase64: body.image_b64,
        seconds: body.seconds,
        steps: body.steps,
      }
    } catch (error) {
      const err = error as Error
      return { ok: false, error: `${err.name}: ${err.message}` }
    }
  })
