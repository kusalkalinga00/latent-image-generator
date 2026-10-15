import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { editImage } from '#/lib/edit'

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

  const bitmap = await createImageBitmap(file)
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
  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    previewUrl: dataUrl,
    base64: dataUrl.split(',')[1] ?? '',
  }
}

function App() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState(4)
  const [seed, setSeed] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [resultUrl, setResultUrl] = useState('')
  const [resultMeta, setResultMeta] = useState('')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [dragging, setDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

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

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setError('')
      const incoming = Array.from(files).filter((f) => f.type.startsWith('image/'))
      if (incoming.length === 0) return

      const room = MAX_IMAGES - attachments.length
      if (room <= 0) {
        setError(`Up to ${MAX_IMAGES} images. Remove one first.`)
        return
      }

      try {
        const prepared = await Promise.all(incoming.slice(0, room).map(prepareImage))
        setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [attachments.length],
  )

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const run = async () => {
    if (attachments.length === 0) {
      setError('Add at least one image.')
      return
    }
    if (!prompt.trim()) {
      setError('Describe the edit you want.')
      return
    }

    setStatus('running')
    setError('')
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
        setError(out.error ?? 'Something went wrong.')
        setStatus('error')
        return
      }

      setResultUrl(`data:image/png;base64,${out.imageBase64}`)
      setResultMeta(`${out.seconds}s on the GPU · ${out.steps} steps`)
      setStatus('done')
    } catch (err) {
      setError((err as Error).message)
      setStatus('error')
    }
  }

  const download = () => {
    if (!resultUrl) return
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = `edited-${Date.now()}.png`
    a.click()
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
        <div className="studio-copy rise">
          <p className="kicker">Studio</p>
          <h1 className="display">Edit a photo by describing the change</h1>
          <p className="lede">
            The first edit of a session takes about half a minute while the model loads.
            After that, each one takes a few seconds.
          </p>
        </div>

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
              1 · Your image{attachments.length ? ` (${attachments.length}/${MAX_IMAGES})` : ''}
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
                <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
                <path d="M21 16l-5.5-5.5L7 19" />
              </svg>
              <span className="text-sm font-medium text-[var(--ink)]">
                {full
                  ? `That is all ${MAX_IMAGES} images`
                  : 'Drop images here or click to choose'}
              </span>
              <span className="max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                Up to {MAX_IMAGES}. Add more than one to combine or compare subjects.
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
                      4 is the distilled default. Above 4 uses the slower standard path.
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
                <span>{status === 'running' ? `Editing… ${elapsed.toFixed(1)}s` : 'Edit image'}</span>
                {status !== 'running' && <span className="arrow" aria-hidden="true">→</span>}
              </button>

              {error && (
                <p role="alert" className="alert">
                  {error}
                </p>
              )}
            </div>
          </section>

          {/* ---------------- 3 · result ---------------- */}
          <section className="card rise rise-late">
            <div className="step-row">
              <h2 className="step-label">3 · Result</h2>
              <span className={`status-pill${status === 'running' ? ' is-busy' : ''}`}>
                <span className="dot" aria-hidden="true" />
                {statusLabel}
              </span>
            </div>

            <div className={`result-stage${status === 'done' && resultUrl ? ' has-image' : ''}`}>
              {status === 'running' ? (
                <div className="developing">
                  {preview && (
                    <img src={preview} alt="" aria-hidden="true" className="develop-ghost" />
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
                <img src={resultUrl} alt="Edited result" className="result-img" />
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
                <p className="m-0 text-xs text-[var(--ink-soft)]">{resultMeta}</p>
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
