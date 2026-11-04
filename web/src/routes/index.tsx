import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { refreshCredit } from '#/lib/credit-store'
import type { Aspect } from '#/lib/edit'
import { ASPECT_LABELS, editImage, generateImage } from '#/lib/edit'
import { pushToast } from '#/lib/toast'

export const Route = createFileRoute('/')({ component: App })

const MAX_IMAGES = 3
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_EDGE = 1536 // the model works around 1MP; larger just costs GPU seconds

// The backend holds one model: 2511 with the 4-step Lightning LoRA attached. There
// is no second "standard" path to switch to, so steps are not a choice the UI can
// offer - passing 4 is the honest thing to send.
const STEPS = 4

const WAIT_PHASES = {
  edit: ['Starting a GPU', 'Loading the model', 'Editing'],
  generate: ['Starting a GPU', 'Loading the model', 'Painting'],
} as const

type Mode = 'edit' | 'generate'

const DOT_COLS = 26
const DOT_ROWS = 15
const DOT_TOTAL = DOT_COLS * DOT_ROWS

/**
 * The order dots light up in.
 *
 * A fixed shuffle, not Math.random(): the field has to look scattered while every
 * tick keeps the same arrangement, or the picture reshuffles itself ten times a
 * second and reads as noise instead of progress.
 */
const DOT_ORDER = (() => {
  const order = Array.from({ length: DOT_TOTAL }, (_, i) => i)
  let seed = 7
  const next = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    const swap = order[i]
    order[i] = order[j]
    order[j] = swap
  }
  return order
})()

function waitStep(elapsed: number, warmed: boolean) {
  if (warmed || elapsed >= 30) return 2
  if (elapsed >= 8) return 1
  return 0
}

function waitProgress(elapsed: number, warmed: boolean) {
  // Never reaches 100: this is an estimate of a wait whose length depends on a
  // cold start, so it stops short and the image arriving is the real completion.
  if (warmed) return Math.min(92, 18 + (elapsed / 4) * 74)
  if (elapsed < 8) return (elapsed / 8) * 30
  if (elapsed < 30) return 30 + ((elapsed - 8) / 22) * 40
  return Math.min(92, 70 + ((elapsed - 30) / 20) * 22)
}

// Short enough to scan as chips; the point is to show the range of edits, not to
// write the prompt for the user.
/**
 * Does the prompt ask for a background-free image?
 *
 * Deliberately narrow: these are phrases about the *output*, not about what is in
 * the picture. "a transparent glass" would match too, and cutting the background
 * out of that is still the sane reading.
 */
const WANTS_CUTOUT =
  /transparen\w*|\bcut\s?-?out\b|no\s+background|remove\s+(the\s+)?background|plain\s+(white|solid)\s+background|isolated\s+on\s+(white|plain)|with\s+alpha\b/i

const EXAMPLES = [
  'Night with warm street lights',
  'Watercolour painting',
  'Cosy cafe, same faces',
  'Change the sign text',
]

interface Attachment {
  id: string
  name: string
  previewUrl: string
  base64: string
}

/**
 * Downscale in the browser before upload.
 *
 * Two practical reasons: the model was trained around 1MP so extra resolution buys
 * nothing but GPU seconds, and Vercel Functions cap request bodies at about 4.5MB
 * which a modern phone photo plus base64 overhead will exceed.
 */
async function prepareImage(file: File): Promise<Attachment> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the 20MB limit`,
    )
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${file.name} could not be read. Try a different image.`)
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process that image in this browser')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1] ?? ''
  if (!base64) throw new Error(`${file.name} could not be prepared.`)

  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    previewUrl: dataUrl,
    base64,
  }
}

/**
 * Wipe between the edit and the original, dragged across the image.
 *
 * The whole image is a range input, so it drags with the mouse, taps, and moves
 * with the arrow keys - no pointer-event maths and no inaccessible custom slider.
 */
function Compare({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(54)

  return (
    <div className="compare">
      <img src={after} alt="Edited result" />
      <img
        src={before}
        alt=""
        aria-hidden="true"
        className="compare-overlay"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="compare-line" style={{ left: `${pos}%` }} />
      <span className="compare-grip" style={{ left: `${pos}%` }}>
        <svg
          viewBox="0 0 6 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M5 1L1 5l4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg
          viewBox="0 0 6 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M1 1l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="stage-tag">Before</span>
      <span className="stage-tag end">After</span>
      <input
        className="compare-range"
        type="range"
        min={0}
        max={100}
        value={pos}
        aria-label="Compare the original with the edit"
        onChange={(event) => setPos(Number(event.target.value))}
      />
    </div>
  )
}

/**
 * The wait, drawn as a field of dots that fills in.
 *
 * A spinner says something is happening; this says how much. It also gives the
 * cold start somewhere to live: the caption names the phase, so 30 seconds of
 * loading reads as a step rather than a stall.
 */
function Sketching({
  elapsed,
  warmed,
  mode,
}: {
  elapsed: number
  warmed: boolean
  mode: Mode
}) {
  const phase = waitStep(elapsed, warmed)
  const progress = Math.round(waitProgress(elapsed, warmed))
  const filled = Math.round((DOT_TOTAL * progress) / 100)
  const label = WAIT_PHASES[mode][phase]

  return (
    <div className="matrix-block">
      <p className="matrix-caption">
        {label} · {elapsed.toFixed(0)}s
      </p>
      <div className="matrix-field">
        <div
          className="matrix"
          style={{ '--cols': DOT_COLS } as CSSProperties}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`${label}, ${progress}%`}
        >
          {DOT_ORDER.map((rank, index) => (
            <i key={index} className={rank < filled ? 'on' : undefined} />
          ))}
        </div>
        <span className="matrix-pct">{progress}%</span>
      </div>
    </div>
  )
}

function App() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [prompt, setPrompt] = useState('')
  const [seed, setSeed] = useState(0)
  const [showSeed, setShowSeed] = useState(false)

  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  )
  const [resultUrl, setResultUrl] = useState('')
  const [resultMeta, setResultMeta] = useState('')
  // Straight from the backend, which knows which checkpoint it called.
  const [resultModel, setResultModel] = useState('')
  const [errorText, setErrorText] = useState('')
  const [lastPrompt, setLastPrompt] = useState('')
  // What the picture on the stage is: an edited photo, or one from nothing.
  const [lastMode, setLastMode] = useState<Mode>('edit')
  const [aspect, setAspect] = useState<Aspect>('1:1')
  // The model cannot emit alpha, so this asks the backend to cut the background
  // out afterwards; `resultAlpha` records whether that actually happened.
  //
  // Default is "decide from the prompt", because a prompt that says "transparent
  // background" is asking for exactly this and should not require finding a
  // 18-pixel icon. A click sets an explicit override for the session; reloading
  // returns to auto, so no stale choice can silently defeat a later prompt.
  const [cutoutOverride, setCutoutOverride] = useState<boolean | null>(null)
  const [resultAlpha, setResultAlpha] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [dragging, setDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const runRef = useRef<() => void>(() => {})
  const statusRef = useRef(status)
  const runId = useRef(0)
  const warmed = useRef(false)
  statusRef.current = status

  // The first run of a session loads 53.76 GiB into VRAM, which takes about 30s
  // before a single denoising step happens. A bare spinner for that reads as
  // broken, so elapsed time stays on screen and the copy says what is happening.
  useEffect(() => {
    if (status !== 'running') return
    setElapsed(0)
    const started = Date.now()
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 100)
    return () => clearInterval(id)
  }, [status])

  // Grow the prompt with its content, up to the cap in CSS.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(132, el.scrollHeight)}px`
  }, [prompt])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      const incoming = list.filter((file) => file.type.startsWith('image/'))
      if (incoming.length === 0) {
        pushToast('error', 'Choose an image file.')
        return
      }
      if (incoming.length < list.length) {
        pushToast('info', 'Skipped files that are not images.')
      }

      const room = MAX_IMAGES - attachments.length
      if (room <= 0) {
        pushToast(
          'error',
          `You can add up to ${MAX_IMAGES} images. Remove one.`,
        )
        return
      }

      const prepared: Attachment[] = []
      for (const file of incoming.slice(0, room)) {
        try {
          prepared.push(await prepareImage(file))
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Could not read that image.'
          pushToast('error', message)
        }
      }

      if (prepared.length > 0) {
        setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES))
        // A new input invalidates whatever is on the stage.
        setResultUrl('')
        setResultMeta('')
        setErrorText('')
        setLastPrompt('')
        setStatus('idle')
      }
      if (incoming.length > room) {
        pushToast(
          'info',
          `Only ${room} more ${room === 1 ? 'image fits' : 'images fit'}. The limit is ${MAX_IMAGES}.`,
        )
      }
    },
    [attachments.length],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter(
        (file) => file.type.startsWith('image/'),
      )
      if (images.length === 0) return
      event.preventDefault()
      void addFiles(images)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return
      if (!(event.metaKey || event.ctrlKey)) return
      if (statusRef.current === 'running') return
      event.preventDefault()
      runRef.current()
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  }, [addFiles])

  const useSample = async () => {
    try {
      const response = await fetch('/sample.png')
      if (!response.ok) throw new Error('The sample image could not be loaded.')
      const blob = await response.blob()
      await addFiles([new File([blob], 'sample.png', { type: 'image/png' })])
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'The sample image could not be loaded.'
      pushToast('error', message)
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
    setResultUrl('')
    setResultMeta('')
    setLastPrompt('')
    setStatus('idle')
  }

  const run = async () => {
    if (!prompt.trim()) {
      pushToast('error', 'Describe what you want.')
      return
    }
    if (statusRef.current === 'running') return

    const id = ++runId.current
    const instruction = prompt.trim()
    const mode = attachments.length > 0 ? 'edit' : 'generate'
    setElapsed(0)
    setErrorText('')
    setLastPrompt(instruction)
    setLastMode(mode)
    setStatus('running')

    try {
      const out =
        mode === 'edit'
          ? await editImage({
              data: {
                imagesBase64: attachments.map((a) => a.base64),
                prompt: instruction,
                steps: STEPS,
                seed,
                transparent,
              },
            })
          : await generateImage({
              data: {
                prompt: instruction,
                steps: STEPS,
                seed,
                aspect,
                transparent,
              },
            })

      if (runId.current !== id) return

      if (!out.ok || !out.imageBase64) {
        const message =
          out.error ?? 'The edit did not finish. Try again in a moment.'
        pushToast('error', message)
        setErrorText(message)
        setStatus('error')
        return
      }

      warmed.current = true
      setResultUrl(`data:image/png;base64,${out.imageBase64}`)
      setResultMeta(`${out.seconds}s · ${out.steps} steps`)
      setResultModel(out.model ?? '')
      setResultAlpha(out.transparent === true)
      setStatus('done')
      pushToast(
        'success',
        out.seconds
          ? `${mode === 'generate' ? 'Generated' : 'Edit ready'} in ${out.seconds}s.`
          : 'Ready.',
      )
      // The credit chip is the only place remaining budget is shown, and this is
      // the only moment it moves.
      void refreshCredit()
    } catch (err) {
      if (runId.current !== id) return
      const message =
        err instanceof Error ? err.message : 'The edit did not finish.'
      const friendly = /fetch|network|load failed/i.test(message)
        ? 'Could not reach the editor. Try again in a moment.'
        : message
      pushToast('error', friendly)
      setErrorText(friendly)
      setStatus('error')
    }
  }

  // Modal cannot cancel work it has already started: this stops the wait and
  // leaves the GPU to finish and bill. The copy says so rather than promising a
  // cancellation that does not happen.
  const stopWaiting = () => {
    runId.current += 1
    setStatus(resultUrl ? 'done' : 'idle')
    pushToast('info', 'Stopped waiting. The GPU may still finish this one.')
  }

  const clearEditor = () => {
    runId.current += 1
    setPrompt('')
    setResultUrl('')
    setResultMeta('')
    setErrorText('')
    setLastPrompt('')
    setResultAlpha(false)
    setStatus('idle')
  }

  const continueFromResult = async () => {
    if (!resultUrl) return
    try {
      const blob = await fetch(resultUrl).then((response) => response.blob())
      const next = await prepareImage(
        new File([blob], 'edited.png', { type: 'image/png' }),
      )
      setAttachments([next])
      setPrompt('')
      setResultUrl('')
      setResultMeta('')
      setLastPrompt('')
      setStatus('idle')
      pushToast('info', 'The result is now the image in the bar below.')
      promptRef.current?.focus()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not use that result.'
      pushToast('error', message)
    }
  }

  const download = () => {
    if (!resultUrl) return
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = `${resultAlpha ? 'cutout' : 'edited'}-${Date.now()}.png`
    a.click()
    pushToast('success', 'Download started.')
  }

  runRef.current = () => {
    void run()
  }

  const preview = attachments[0]?.previewUrl ?? ''
  const wantedCutout = WANTS_CUTOUT.test(prompt)
  const transparent = cutoutOverride ?? wantedCutout
  const running = status === 'running'
  const full = attachments.length >= MAX_IMAGES
  const done = status === 'done' && Boolean(resultUrl)

  return (
    <>
      <main
        className={`stage${dragging ? ' is-hot' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void addFiles(e.dataTransfer.files)
        }}
      >
        {preview || resultUrl || running ? (
          <div className="thread">
            {lastPrompt && <p className="bubble">{lastPrompt}</p>}

            {running ? (
              <Sketching
                elapsed={elapsed}
                warmed={warmed.current}
                mode={lastMode}
              />
            ) : (
              <>
                <figure
                  className={`frame${done && resultAlpha ? ' is-alpha' : ''}`}
                >
                  {done && preview ? (
                    <Compare before={preview} after={resultUrl} />
                  ) : done && resultUrl ? (
                    <>
                      <img
                        src={resultUrl}
                        alt={lastPrompt || 'Generated image'}
                      />
                      <span className="stage-tag end">Generated</span>
                    </>
                  ) : preview ? (
                    <>
                      <img
                        src={preview}
                        alt={attachments[0]?.name ?? 'Your image'}
                      />
                      <span className="stage-tag">Original</span>
                    </>
                  ) : null}
                </figure>

                {done && (
                  <div className="stage-bar">
                    <span title={resultModel || undefined}>
                      {resultModel
                        ? resultModel.split('/').pop()
                        : lastMode === 'generate'
                          ? 'Generated'
                          : 'Edited'}{' '}
                      · {resultMeta}
                      {resultAlpha && ' · transp.'}
                    </span>
                    <span className="acts">
                      <button
                        type="button"
                        className="btn is-primary"
                        onClick={download}
                      >
                        Download PNG
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void continueFromResult()}
                      >
                        Edit this result
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={clearEditor}
                      >
                        Start over
                      </button>
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <section className="empty">
            <h1>Describe an image, or drop a photo</h1>
            <p>
              With a photo, your words change it. Without one, they make
              something new. Nothing is stored either way.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => inputRef.current?.click()}
              >
                Choose a photo
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void useSample()}
              >
                Try the sample
              </button>
            </div>
          </section>
        )}
      </main>

      <div className="dock">
        {status === 'error' && errorText && (
          <div className="notice is-error" role="alert">
            <span className="dot" aria-hidden="true" />
            <span className="grow">{errorText}</span>
            <button type="button" className="btn" onClick={() => void run()}>
              Try again
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <ul className="thumbs">
            {attachments.map((a) => (
              <li key={a.id} className="thumb">
                <img src={a.previewUrl} alt={a.name} />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="thumb-remove"
                >
                  ×
                </button>
              </li>
            ))}
            {!full && (
              <li>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="thumb thumb-add"
                  aria-label="Add another image"
                >
                  +
                </button>
              </li>
            )}
            <li className="thumbs-meta">
              {showSeed ? (
                <label className="seed">
                  <span>Seed</span>
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                    aria-label="Seed"
                  />
                </label>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSeed(true)}
                  className="chip"
                  title="Same seed and same input gives the same result"
                >
                  Seed
                </button>
              )}
            </li>
          </ul>
        )}

        {!prompt.trim() && !running && attachments.length > 0 && (
          <div className="suggestions">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setPrompt(example)
                  promptRef.current?.focus()
                }}
                className="chip"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void run()
          }}
        >
          <button
            type="button"
            className="attach"
            aria-label="Add an image"
            onClick={() => inputRef.current?.click()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>

          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={1}
            placeholder={
              attachments.length > 0
                ? 'Describe the change…'
                : 'Describe the image you want…'
            }
            className="field"
            aria-label={
              attachments.length > 0
                ? 'Describe the change'
                : 'Describe the image'
            }
            readOnly={running}
          />

          <button
            type="button"
            className={`icon-toggle${transparent ? ' is-on' : ''}`}
            onClick={() => setCutoutOverride(!transparent)}
            aria-pressed={transparent}
            aria-label="Transparent background"
            title={
              transparent
                ? cutoutOverride === null
                  ? 'Your prompt asks for transparency, so the background will be cut out. Click to keep it.'
                  : 'Background will be cut out (PNG with alpha). Click to keep it.'
                : wantedCutout
                  ? 'Turned off for this prompt, though it asks for transparency. Click to cut it out.'
                  : 'Cut the background out of the result'
            }
            disabled={running}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="3.6"
                y="3.6"
                width="16.8"
                height="16.8"
                rx="3.4"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M6.2 6.2h5.8v5.8H6.2zM12 12h5.8v5.8H12z"
                fill="currentColor"
              />
            </svg>
          </button>

          {attachments.length === 0 && !running && (
            <label className="shape">
              <span className="sr-only">Image shape</span>
              <select
                value={aspect}
                onChange={(e) => setAspect(e.target.value as Aspect)}
                aria-label="Image shape"
              >
                {(Object.keys(ASPECT_LABELS) as Aspect[]).map((value) => (
                  <option key={value} value={value}>
                    {ASPECT_LABELS[value]}
                  </option>
                ))}
              </select>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path
                  d="M6 9l6 6 6-6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </label>
          )}

          {running ? (
            <button
              type="button"
              className="send"
              onClick={stopWaiting}
              aria-label="Stop waiting"
              title="This stops the wait. Modal cannot cancel a call already running, so the GPU may still finish and bill."
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                width="20"
                height="20"
              >
                <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              disabled={!prompt.trim()}
              aria-label={
                attachments.length > 0 ? 'Edit the image' : 'Generate an image'
              }
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <path
                  d="M12 19V5M5.5 11.5L12 5l6.5 6.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </form>

        <p className="disclaimer">
          Qwen-Image · on-demand GPU · <b>images are not stored</b>
          {transparent && ' · background cut out'}
          <span className="only-pointer"> · ⌘↵ to send</span>
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}
