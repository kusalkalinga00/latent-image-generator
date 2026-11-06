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
 *
 * Two jobs share one endpoint. Modal decides between them by whether a photo
 * arrived with the prompt - an image means edit, no image means generate - so
 * each handler below only has to validate its own case.
 */

export interface EditInput {
  imagesBase64: string[]
  prompt: string
  steps: number
  seed: number
  transparent?: boolean
  /** Client-chosen id, so the render can be collected if the reply is lost. */
  jobId?: string
}

export interface GenerateInput {
  prompt: string
  steps: number
  seed: number
  aspect: Aspect
  transparent?: boolean
  jobId?: string
}

export interface EditOutput {
  ok: boolean
  mode?: 'edit' | 'generate'
  model?: string
  /** The render is still running: ask again rather than starting a new one. */
  pending?: boolean
  /** The render finished but has aged out of the result store. */
  expired?: boolean
  /** The request failed in transit — the render may still have completed. */
  network?: boolean
  /** True when the backend returned a cut-out with a real alpha channel. */
  transparent?: boolean
  imageBase64?: string
  seconds?: number
  steps?: number
  size?: [number, number]
  error?: string
}

/** The buckets the model was trained at; off-bucket sizes cost quality. */
export const ASPECTS = [
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
] as const
export type Aspect = (typeof ASPECTS)[number]

/** Only the four worth offering in a bar; the rest stay valid server-side. */
export const ASPECT_LABELS: Partial<Record<Aspect, string>> = {
  '1:1': 'Square',
  '3:2': 'Wide',
  '2:3': 'Tall',
  '16:9': 'Cinema',
}

interface ModalPayload {
  image_b64: string[]
  prompt: string
  steps: number
  seed: number
  aspect?: string
  transparent?: boolean
  /** Chosen by the client before sending, so a lost reply can be collected. */
  job_id?: string
}

function failed(error: string, extra: Partial<EditOutput> = {}): EditOutput {
  return { ok: false, error, ...extra }
}

/**
 * Where finished renders are collected from.
 *
 * Modal derives a web endpoint's URL from the function name, so the result
 * endpoint sits beside the api one; allow an override for a renamed app.
 */
function resultUrl(apiUrl: string): string {
  const override = process.env.IMAGE_EDITOR_RESULT_URL
  if (override) return override
  const derived = apiUrl.replace(/-api(?=\.|$)/, '-result')
  return derived === apiUrl ? '' : derived
}

function modelMessage(value: unknown) {
  if (typeof value !== 'string') return ''
  const message = value.trim()
  if (!message || message.length > 180 || /traceback|exception/i.test(message))
    return ''
  return message
}

/**
 * The single transport. `expect` only checks the reply, so a generate request
 * that somehow came back as an edit fails loudly instead of being shown as one.
 */
async function callModal(
  payload: ModalPayload,
  expect: 'edit' | 'generate',
): Promise<EditOutput> {
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
    console.error('Image editor is missing configuration:', missing.join(', '))
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
      body: JSON.stringify(payload),
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
      mode?: 'edit' | 'generate'
      model?: string
      transparent?: boolean
      error?: unknown
      image_b64?: string
      seconds?: number
      steps?: number
      size?: [number, number]
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
      return failed(detail || 'The edit did not finish. Try again in a moment.')
    }

    if (body.mode && body.mode !== expect) {
      console.error('Image editor answered the wrong mode:', body.mode, expect)
      return failed('The editor answered something unexpected. Try again.')
    }

    return {
      ok: true,
      mode: body.mode,
      model: typeof body.model === 'string' ? body.model : undefined,
      transparent: body.transparent === true,
      imageBase64: body.image_b64,
      seconds: body.seconds,
      steps: body.steps,
      size: body.size,
    }
  } catch (error) {
    console.error('Image editor request failed:', error)
    // A transport failure is not a model failure: the render may well have
    // finished, so the caller can try to collect it by job id.
    return failed('Could not reach the editor. Try again in a moment.', {
      network: true,
    })
  }
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

    return callModal(
      {
        image_b64: data.imagesBase64,
        prompt: data.prompt.trim(),
        steps: data.steps,
        seed: data.seed,
        transparent: data.transparent === true,
        job_id: data.jobId,
      },
      'edit',
    )
  })

export const generateImage = createServerFn({ method: 'POST' })
  .validator((data: GenerateInput) => data)
  .handler(async ({ data }): Promise<EditOutput> => {
    if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return failed('Describe the image you want.')
    }
    if (data.prompt.length > 2000) {
      return failed('That prompt is too long. Keep it under 2000 characters.')
    }
    if (!ASPECTS.includes(data.aspect)) {
      return failed('Pick a shape for the image.')
    }
    if (!Number.isInteger(data.steps) || data.steps < 4 || data.steps > 20) {
      return failed('Steps must be between 4 and 20.')
    }
    if (!Number.isFinite(data.seed)) {
      return failed('Seed must be a number.')
    }

    return callModal(
      {
        image_b64: [],
        prompt: data.prompt.trim(),
        steps: data.steps,
        seed: data.seed,
        aspect: data.aspect,
        transparent: data.transparent === true,
        job_id: data.jobId,
      },
      'generate',
    )
  })

/**
 * Collect a render by job id.
 *
 * Called when the original request's reply never arrived — the usual cause is a
 * phone locking mid-render, which tears the connection down while the GPU keeps
 * working. `pending` means "not finished, keep waiting"; anything else is either
 * the image or a reason there is none.
 */
export const collectResult = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string }) => data)
  .handler(async ({ data }): Promise<EditOutput> => {
    const apiUrl = process.env.IMAGE_EDITOR_API_URL
    const tokenId = process.env.MODAL_PROXY_TOKEN_ID
    const tokenSecret = process.env.MODAL_PROXY_TOKEN_SECRET
    const url = apiUrl ? resultUrl(apiUrl) : ''

    if (!url || !tokenId || !tokenSecret) {
      return failed('The editor is not available right now.')
    }
    if (!/^[A-Za-z0-9-]{8,64}$/.test(data.jobId)) {
      return failed('That result id is not valid.')
    }

    try {
      const response = await fetch(
        `${url}?job_id=${encodeURIComponent(data.jobId)}`,
        { headers: { Authorization: `Bearer ${tokenId}.${tokenSecret}` } },
      )
      if (!response.ok) {
        return failed('Could not look that result up.', { network: true })
      }

      const body = (await response.json()) as {
        ok?: boolean
        pending?: boolean
        expired?: boolean
        error?: unknown
        mode?: 'edit' | 'generate'
        model?: string
        transparent?: boolean
        image_b64?: string
        seconds?: number
        steps?: number
        size?: [number, number]
      }

      if (body.pending) return { ok: false, pending: true }
      if (body.expired) {
        return failed('That render expired before it could be collected.', {
          expired: true,
        })
      }
      if (!body.ok || !body.image_b64) {
        return failed(modelMessage(body.error) || 'That result is unavailable.')
      }

      return {
        ok: true,
        mode: body.mode,
        model: typeof body.model === 'string' ? body.model : undefined,
        transparent: body.transparent === true,
        imageBase64: body.image_b64,
        seconds: body.seconds,
        steps: body.steps,
        size: body.size,
      }
    } catch (error) {
      console.error('Image editor result lookup failed:', error)
      return failed('Could not reach the editor. Try again in a moment.', {
        network: true,
      })
    }
  })
