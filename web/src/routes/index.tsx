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

const WAIT_STEPS = ['Starting a GPU', 'Loading the model', 'Editing'] as const

function waitStep(elapsed: number, warmed: boolean) {
  if (warmed || elapsed >= 30) return 2
  if (elapsed >= 8) return 1
  return 0
}

function waitProgress(elapsed: number, warmed: boolean) {
  if (warmed) return Math.min(92, 18 + (elapsed / 4) * 74)
  if (elapsed < 8) return (elapsed / 8) * 30
  if (elapsed < 30) return 30 + ((elapsed - 8) / 22) * 40
  return Math.min(92, 70 + ((elapsed - 30) / 20) * 22)
}

function waitDetail(step: number, warmed: boolean) {
  if (warmed || step === 2) return 'The GPU is working on your image.'
  if (step === 1) {
    return 'The model is loading. About 30 seconds is normal the first time.'
  }
  return 'A GPU is starting. The first edit takes longer than the ones after it.'
}

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

function Compare({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(56)

  return (
    <div className="compare">
      <img src={after} alt="Edited result" className="result-img" />
      <img
        src={before}
        alt=""
        aria-hidden="true"
        className="compare-before result-img"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="stage-tag">Before</span>
      <span className="stage-tag stage-tag-end">After</span>
      <span
        className="compare-handle"
        style={{ left: `${pos}%` }}
        aria-hidden="true"
      />
      <input
        className="compare-range"
        type="range"
        min={0}
        max={100}
        value={pos}
        aria-label="Compare the original and the edit"
        onChange={(event) => setPos(Number(event.target.value))}
      />
    </div>
  )
}

function CreditSkeleton() {
  return (
    <section
      className="credit-card"
      aria-busy="true"
      aria-label="Loading monthly credit"
    >
      <div className="credit-head">
        <span className="skeleton skeleton-label" />
        <span className="skeleton skeleton-amount" />
      </div>
      <span className="skeleton skeleton-meter" />
      <div className="credit-scale">
        <span className="skeleton skeleton-caption" />
        <span className="skeleton skeleton-caption" />
      </div>
      <div className="credit-badges">
        <span className="skeleton skeleton-badge" />
        <span className="skeleton skeleton-badge" />
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
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const runRef = useRef<() => void>(() => {})
  const statusRef = useRef(status)
  const resultRef = useRef<HTMLElement>(null)
  const runId = useRef(0)
  const warmed = useRef(false)
  statusRef.current = status
  const [shortcut, setShortcut] = useState('Ctrl+Enter')

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

  useEffect(() => {
    const apple = /Mac|iPhone|iPad/.test(navigator.platform)
    if (apple) setShortcut('⌘ Enter')
  }, [])

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

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const run = async () => {
    if (attachments.length === 0) {
      pushToast('error', 'Add an image.')
      return
    }
    if (!prompt.trim()) {
      pushToast('error', 'Describe the change.')
      return
    }
    if (statusRef.current === 'running') return

    const id = ++runId.current
    setStatus('running')
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    try {
      const out = await editImage({
        data: {
          imagesBase64: attachments.map((a) => a.base64),
          prompt: prompt.trim(),
          steps,
          seed,
        },
      })

      if (runId.current !== id) return

      if (!out.ok || !out.imageBase64) {
        pushToast('error', out.error ?? 'The edit did not finish. Try again.')
        setStatus('error')
        return
      }

      warmed.current = true
      setResultUrl(`data:image/png;base64,${out.imageBase64}`)
      setResultMeta(`${out.seconds}s on the GPU · ${out.steps} steps`)
      setStatus('done')
      pushToast(
        'success',
        out.seconds ? `Edit ready in ${out.seconds}s.` : 'Edit ready.',
      )
    } catch (err) {
      if (runId.current !== id) return
      const message =
        err instanceof Error ? err.message : 'The edit did not finish.'
      const friendly = /fetch|network|load failed/i.test(message)
        ? 'Could not reach the editor. Try again in a moment.'
        : message
      pushToast('error', friendly)
      setStatus('error')
    }
  }

  const cancelEdit = () => {
    runId.current += 1
    setStatus(resultUrl ? 'done' : 'idle')
    pushToast('info', 'Edit cancelled.')
  }

  const continueFromResult = async () => {
    if (!resultUrl) return
    try {
      const blob = await fetch(resultUrl).then((response) => response.blob())
      const next = await prepareImage(
        new File([blob], 'edited.png', { type: 'image/png' }),
      )
      setAttachments([next])
      setResultUrl('')
      setResultMeta('')
      setStatus('idle')
      pushToast('info', 'This result is now the image to edit.')
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
    a.download = `edited-${Date.now()}.png`
    a.click()
    pushToast('success', 'Download started.')
  }

  runRef.current = () => {
    void run()
  }

  const preview = attachments[0]?.previewUrl ?? ''
  const phase = waitStep(elapsed, warmed.current)
  const progress = Math.round(waitProgress(elapsed, warmed.current))
  const editReason =
    attachments.length === 0
      ? 'Add an image'
      : !prompt.trim()
        ? 'Describe the change'
        : null
  const full = attachments.length >= MAX_IMAGES
  const statusLabel =
    status === 'running'
      ? `${WAIT_STEPS[phase]} · ${elapsed.toFixed(0)}s`
      : status === 'done'
        ? 'Ready'
        : status === 'error'
          ? 'Needs attention'
          : preview
            ? 'Ready to edit'
            : 'Idle'

  return (
    <main className="studio-page">
      <div className="studio">
        {credit === null ? (
          <CreditSkeleton />
        ) : (
          credit.ok && <CreditCard credit={credit} />
        )}

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
              ref={promptRef}
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
                disabled={status === 'running' || editReason !== null}
                className="btn-primary"
              >
                <span>
                  {status === 'running'
                    ? `Editing… ${elapsed.toFixed(1)}s`
                    : (editReason ?? 'Edit image')}
                </span>
                {status !== 'running' && !editReason && (
                  <span className="arrow" aria-hidden="true">
                    →
                  </span>
                )}
              </button>
              {!editReason && status !== 'running' && (
                <p className="shortcut-hint">{shortcut} to edit</p>
              )}
            </div>
          </section>

          {/* ---------------- 3 · result ---------------- */}
          <section ref={resultRef} className="card rise rise-late">
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
              className={`result-stage${(status === 'done' && resultUrl) || (status === 'idle' && preview) ? ' has-image' : ''}`}
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
                    <ol className="wait-steps">
                      {WAIT_STEPS.map((label, index) => (
                        <li
                          key={label}
                          className={
                            index === phase
                              ? 'is-current'
                              : index < phase
                                ? 'is-done'
                                : undefined
                          }
                        >
                          {label}
                        </li>
                      ))}
                    </ol>
                    <p className="m-0 text-sm font-medium text-[var(--ink)]">
                      {WAIT_STEPS[phase]} — {elapsed.toFixed(0)}s
                    </p>
                    <div
                      className="develop-meter"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                      aria-label={WAIT_STEPS[phase]}
                    >
                      <i
                        className="is-fill"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="m-0 max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                      {waitDetail(phase, warmed.current)}
                    </p>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="btn-quiet h-10 px-4 text-xs font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : status === 'done' && resultUrl ? (
                preview ? (
                  <Compare before={preview} after={resultUrl} />
                ) : (
                  <img
                    src={resultUrl}
                    alt="Edited result"
                    className="result-img"
                  />
                )
              ) : status === 'error' ? (
                <>
                  <span className="text-xl" aria-hidden="true">
                    ⚠️
                  </span>
                  <p className="m-0 max-w-xs text-sm leading-6 text-[var(--ink-soft)]">
                    The edit did not finish. Adjust the prompt and try again.
                  </p>
                </>
              ) : preview ? (
                <div className="preview-frame">
                  <img
                    src={preview}
                    alt={attachments[0]?.name ?? 'Selected image'}
                    className="result-img"
                  />
                  <span className="stage-tag">Original</span>
                </div>
              ) : (
                <>
                  <span className="text-xl" aria-hidden="true">
                    ✨
                  </span>
                  <p className="m-0 max-w-xs text-sm leading-6 text-[var(--ink-soft)]">
                    Your edited image will appear here.
                  </p>
                  <button
                    type="button"
                    onClick={() => void useSample()}
                    className="btn-quiet h-10 px-4 text-xs font-medium"
                  >
                    Try a sample
                  </button>
                </>
              )}
            </div>

            {status === 'done' && resultUrl && (
              <div className="result-bar">
                <p className="m-0 text-xs text-[var(--ink-soft)]">
                  {resultMeta}
                </p>
                <div className="result-actions">
                  <button
                    type="button"
                    onClick={() => void continueFromResult()}
                    className="btn-quiet h-10 px-4 text-xs font-medium"
                  >
                    Edit this result
                  </button>
                  <button
                    type="button"
                    onClick={download}
                    className="btn-quiet h-10 px-4 text-xs font-medium"
                  >
                    Download PNG
                  </button>
                </div>
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
