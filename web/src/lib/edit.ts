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

function failed(error: string): EditOutput {
  return { ok: false, error }
}

function modelMessage(value: unknown) {
  if (typeof value !== 'string') return ''
  const message = value.trim()
  if (!message || message.length > 180 || /traceback|exception/i.test(message))
    return ''
  return message
}

export const editImage = createServerFn({ method: 'POST' })
  .validator((data: EditInput) => data)
  .handler(async ({ data }): Promise<EditOutput> => {
    if (!Array.isArray(data.imagesBase64) || data.imagesBase64.length === 0) {
      return failed('Add at least one image.')
    }
    if (data.imagesBase64.length > 3) {
      return failed('You can add up to 3 images.')
    }
    if (
      data.imagesBase64.some(
        (image) => typeof image !== 'string' || image.length === 0,
      )
    ) {
      return failed(
        'One of the images could not be read. Try a different file.',
      )
    }
    if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return failed('Describe the edit you want.')
    }
    if (!Number.isInteger(data.steps) || data.steps < 4 || data.steps > 20) {
      return failed('Steps must be between 4 and 20.')
    }
    if (!Number.isFinite(data.seed)) {
      return failed('Seed must be a number.')
    }

    // Named *_PROXY_* deliberately. MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are the
    // Modal CLI's own auth variables, and these are *proxy* tokens (wk-/ws-) used
    // only for web-function auth - a different credential type entirely. Sharing
    // the name means anyone who sources this env file breaks their `modal` CLI
    // with "Token ID is malformed", which is exactly what happened while building
    // this. Distinct names, distinct meaning.
    const apiUrl = process.env.IMAGE_EDITOR_API_URL
    const tokenId = process.env.MODAL_PROXY_TOKEN_ID
    const tokenSecret = process.env.MODAL_PROXY_TOKEN_SECRET

    if (!apiUrl || !tokenId || !tokenSecret) {
      const missing = [
        !apiUrl && 'IMAGE_EDITOR_API_URL',
        !tokenId && 'MODAL_PROXY_TOKEN_ID',
        !tokenSecret && 'MODAL_PROXY_TOKEN_SECRET',
      ].filter(Boolean)
      console.error(
        'Image editor is missing configuration:',
        missing.join(', '),
      )
      return failed('The editor is not available right now.')
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
        console.error(
          'Image editor request failed:',
          response.status,
          text.slice(0, 300),
        )
        return failed('The edit did not finish. Try again in a moment.')
      }

      let body: {
        ok?: boolean
        error?: unknown
        image_b64?: string
        seconds?: number
        steps?: number
      }
      try {
        body = JSON.parse(text)
      } catch (error) {
        console.error('Image editor returned invalid JSON:', error)
        return failed('The edit did not finish. Try again in a moment.')
      }

      if (!body.ok || !body.image_b64) {
        const detail = modelMessage(body.error)
        if (!detail && body.error)
          console.error('Image editor model error:', body.error)
        return failed(
          detail || 'The edit did not finish. Try again in a moment.',
        )
      }

      return {
        ok: true,
        imageBase64: body.image_b64,
        seconds: body.seconds,
        steps: body.steps,
      }
    } catch (error) {
      console.error('Image editor request failed:', error)
      return failed('Could not reach the editor. Try again in a moment.')
    }
  })
