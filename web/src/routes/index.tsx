import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreditView } from '#/lib/credit'
import { getCredit } from '#/lib/credit'
import { editImage } from '#/lib/edit'
import { pushToast } from '#/lib/toast'

export const Route = createFileRoute('/')({ component: App })

const MAX_IMAGES = 3
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_EDGE = 1536 // the model works around 1MP; larger just costs GPU seconds

const EXAMPLES = [
  'Make it night time with warm street lights',
  'Put them in a cozy cafe, keep their faces the same',
  'Change the text on the sign to read "GRAND OPENING"',
  'Make it look like a watercolour painting',
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
  // createImageBitmap always returns an object with close(); the optional chain
  // here was flagged as unnecessary and it was.
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

function money(amount: number) {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })
}

function CreditCard({ credit }: { credit: CreditView }) {
  const allowance = credit.allowanceUsd ?? 30
  const remaining = Math.max(0, credit.remainingUsd ?? 0)
  const used = Math.max(0, allowance - remaining)
  const usedPct = allowance > 0 ? Math.min(100, (used / allowance) * 100) : 0
  const cold = (credit.coldEdits ?? 0).toLocaleString('en-US')
  const warm = (credit.warmEdits ?? 0).toLocaleString('en-US')

  return (
    <section className="credit-card rise" aria-label="Monthly credit">
      <div className="credit-head">
        <p className="step-label">Monthly credit</p>
        <p className="credit-left">{money(remaining)} left</p>
      </div>
      <div
        className="credit-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={Math.round(allowance * 100)}
        aria-valuenow={Math.round(used * 100)}
        aria-label={`${money(used)} of ${money(allowance)} used`}
      >
        <span style={{ width: `${usedPct}%` }} />
      </div>
      <p className="credit-scale">
        <span>{money(used)} used</span>
        <span>{money(allowance)}</span>
      </p>
      <div className="credit-badges">
        <p className="credit-badge">
          <span>Cold start</span>
          <strong>{cold}</strong>
          <span>edits</span>
        </p>
        <p className="credit-badge">
          <span>GPU warm</span>
          <strong>{warm}</strong>
          <span>edits</span>
        </p>
      </div>
    </section>
  )
}

function App() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState(4)
  const [seed, setSeed] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  )
  const [resultUrl, setResultUrl] = useState('')
  const [resultMeta, setResultMeta] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [credit, setCredit] = useState<CreditView | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // The first run of a session loads 53.76 GiB into VRAM, which takes about 30s
  // before a single denoising step happens. A bare spinner for that reads as
  // broken, so elapsed time stays on screen and the copy says what is happening.
  useEffect(() => {
    let cancelled = false
    void getCredit().then((next) => {
      if (!cancelled) setCredit(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status !== 'running') return
    setElapsed(0)
    const started = Date.now()
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 100)
    return () => clearInterval(id)
  }, [status])

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
          `You can add up to ${MAX_IMAGES} images. Remove one first.`,
        )
        return
      }

      const accepted = incoming.slice(0, room)
      const prepared: Attachment[] = []
      for (const file of accepted) {
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
      }
      if (incoming.length > room) {
        const noun = room === 1 ? 'image fits' : 'images fit'
        pushToast(
          'info',
          `Only ${room} more ${noun}. The limit is ${MAX_IMAGES}.`,
        )
      }
    },
    [attachments.length],
  )

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const run = async () => {
    if (attachments.length === 0) {
      pushToast('error', 'Add at least one image.')
      return
    }
    if (!prompt.trim()) {
      pushToast('error', 'Describe the edit you want.')
      return
    }

    setStatus('running')
    setResultUrl('')
    setResultMeta('')

    try {
      const out = await editImage({
        data: {
          imagesBase64: attachments.map((a) => a.base64),
          prompt: prompt.trim(),
          steps,
          seed,
        },
      })

      if (!out.ok || !out.imageBase64) {
        pushToast('error', out.error ?? 'The edit did not finish. Try again.')
        setStatus('error')
        return
      }

      setResultUrl(`data:image/png;base64,${out.imageBase64}`)
      setResultMeta(`${out.seconds}s on the GPU · ${out.steps} steps`)
      setStatus('done')
      pushToast(
        'success',
        out.seconds ? `Edit ready in ${out.seconds}s.` : 'Edit ready.',
      )
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'The edit did not finish.'
      const friendly = /fetch|network|load failed/i.test(message)
        ? 'Could not reach the editor. Try again in a moment.'
        : message
      pushToast('error', friendly)
      setStatus('error')
    }
  }

  const download = () => {
    if (!resultUrl) return
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = `edited-${Date.now()}.png`
    a.click()
    pushToast('success', 'Download started.')
  }

  const preview = attachments[0]?.previewUrl ?? ''
  const full = attachments.length >= MAX_IMAGES
  const statusLabel =
    status === 'running'
      ? `Developing · ${elapsed.toFixed(0)}s`
      : status === 'done'
        ? 'Ready'
        : status === 'error'
          ? 'Needs attention'
          : 'Idle'

  return (
    <main className="studio-page">
      <div className="studio">
        {credit?.ok && <CreditCard credit={credit} />}

        <div className="work-grid">
          {/* ---------------- 1 + 2 · input ---------------- */}
          <section
            className="card rise"
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
            <h2 className="step-label">
              1 · Your image
              {attachments.length
                ? ` (${attachments.length}/${MAX_IMAGES})`
                : ''}
            </h2>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={full}
              className={`dropzone${dragging ? ' is-hot' : ''}`}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="h-6 w-6 text-[var(--ink-soft)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle
                  cx="8.5"
                  cy="10"
                  r="1.5"
                  fill="currentColor"
                  stroke="none"
                />
                <path d="M21 16l-5.5-5.5L7 19" />
              </svg>
              <span className="text-sm font-medium text-[var(--ink)]">
                {full
                  ? `That is all ${MAX_IMAGES} images`
                  : 'Drop images here or click to choose'}
              </span>
              <span className="max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                Up to {MAX_IMAGES}. Add more than one to combine or compare
                subjects.
              </span>
            </button>

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
              </ul>
            )}

            <h2 className="step-label">2 · What should change?</h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Make the sky a dramatic sunset and keep the subject unchanged"
              className="field"
            />

            <div className="examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setPrompt(example)}
                  className="chip"
                >
                  {example}
                </button>
              ))}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="inline-flex min-h-11 items-center text-xs font-medium text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? 'Hide advanced' : 'Show advanced'}
              </button>

              {showAdvanced && (
                <div className="advanced mt-2">
                  <label className="text-xs font-medium text-[var(--ink-soft)]">
                    Steps: {steps}
                    <input
                      type="range"
                      min={4}
                      max={20}
                      step={1}
                      value={steps}
                      onChange={(e) => setSteps(Number(e.target.value))}
                      className="mt-2 w-full"
                    />
                    <span className="mt-1 block font-normal leading-5">
                      4 is the distilled default. Above 4 uses the slower
                      standard path.
                    </span>
                  </label>
                  <label className="text-xs font-medium text-[var(--ink-soft)]">
                    Seed
                    <input
                      type="number"
                      value={seed}
                      onChange={(e) => setSeed(Number(e.target.value))}
                      className="field mt-2 h-10"
                    />
                    <span className="mt-1 block font-normal leading-5">
                      Same seed and input gives the same result.
                    </span>
                  </label>
                </div>
              )}
            </div>

            <div className="card-foot">
              <button
                type="button"
                onClick={() => void run()}
                disabled={status === 'running'}
                className="btn-primary"
              >
                <span>
                  {status === 'running'
                    ? `Editing… ${elapsed.toFixed(1)}s`
                    : 'Edit image'}
                </span>
                {status !== 'running' && (
                  <span className="arrow" aria-hidden="true">
                    →
                  </span>
                )}
              </button>
            </div>
          </section>

          {/* ---------------- 3 · result ---------------- */}
          <section className="card rise rise-late">
            <div className="step-row">
              <h2 className="step-label">3 · Result</h2>
              <span
                className={`status-pill${status === 'running' ? ' is-busy' : ''}`}
              >
                <span className="dot" aria-hidden="true" />
                {statusLabel}
              </span>
            </div>

            <div
              className={`result-stage${status === 'done' && resultUrl ? ' has-image' : ''}`}
            >
              {status === 'running' ? (
                <div className="developing">
                  {preview && (
                    <img
                      src={preview}
                      alt=""
                      aria-hidden="true"
                      className="develop-ghost"
                    />
                  )}
                  <div className="develop-inner">
                    <div className="develop-lights" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <p className="m-0 text-sm font-medium text-[var(--ink)]">
                      Developing — {elapsed.toFixed(1)}s
                    </p>
                    <div className="develop-meter" aria-hidden="true">
                      <i />
                    </div>
                    <p className="m-0 max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                      {elapsed < 30
                        ? 'If this is the first edit in a while, a GPU is starting and loading the model. About 30 seconds is normal.'
                        : 'The GPU is hot now. Your edit is developing.'}
                    </p>
                  </div>
                </div>
              ) : status === 'done' && resultUrl ? (
                <img
                  src={resultUrl}
                  alt="Edited result"
                  className="result-img"
                />
              ) : status === 'error' ? (
                <>
                  <span className="text-xl" aria-hidden="true">
                    ⚠️
                  </span>
                  <p className="m-0 max-w-xs text-sm leading-6 text-[var(--ink-soft)]">
                    The edit did not finish. Adjust the prompt and try again.
                  </p>
                </>
              ) : (
                <>
                  <span className="text-xl" aria-hidden="true">
                    ✨
                  </span>
                  <p className="m-0 max-w-xs text-sm leading-6 text-[var(--ink-soft)]">
                    Your edited image will appear here.
                  </p>
                </>
              )}
            </div>

            {status === 'done' && resultUrl && (
              <div className="result-bar">
                <p className="m-0 text-xs text-[var(--ink-soft)]">
                  {resultMeta}
                </p>
                <button
                  type="button"
                  onClick={download}
                  className="btn-quiet h-10 px-4 text-xs font-medium"
                >
                  Download PNG
                </button>
              </div>
            )}
          </section>
        </div>
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
    </main>
  )
}
