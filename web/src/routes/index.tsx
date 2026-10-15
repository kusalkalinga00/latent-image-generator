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

  return (
    <main className="page-wrap py-6 sm:py-10">
      <section className="mb-6 max-w-2xl sm:mb-8">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--ink-soft)]">
          Qwen-Image-Edit
        </p>
        <h1 className="text-2xl font-medium tracking-tight text-[var(--ink)] sm:text-3xl">
          Edit a photo by describing the change
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)] sm:text-[15px]">
          The first edit of a session takes about half a minute while the model loads.
          After that, edits take a few seconds.
        </p>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        <section
          className="panel rounded-xl p-4 sm:p-5"
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
          <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-[var(--ink-soft)]">
            Image{attachments.length ? ` · ${attachments.length}/${MAX_IMAGES}` : ''}
          </h2>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={attachments.length >= MAX_IMAGES}
            className={`mb-3 flex min-h-32 w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition ${
              dragging
                ? 'border-[var(--ink)] bg-[var(--surface-muted)]'
                : 'border-[var(--line)] bg-[var(--surface-muted)] hover:border-[var(--ink-soft)]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span className="text-sm font-medium text-[var(--ink)]">
              {attachments.length >= MAX_IMAGES
                ? `That is all ${MAX_IMAGES} images`
                : 'Drop images here or tap to choose'}
            </span>
            <span className="mt-1 max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
              Up to {MAX_IMAGES}. Add more than one to combine or compare subjects.
            </span>
          </button>

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

          {attachments.length > 0 && (
            <ul className="mb-5 grid grid-cols-3 gap-2">
              {attachments.map((a) => (
                <li
                  key={a.id}
                  className="relative overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-muted)]"
                >
                  <img src={a.previewUrl} alt={a.name} className="aspect-square w-full object-cover sm:h-28 sm:aspect-auto" />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.name}`}
                    className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md bg-slate-950/75 text-sm text-white"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-[var(--ink-soft)]">
            Prompt
          </h2>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Make the sky a dramatic sunset and keep the subject unchanged"
            className="mb-3 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-3 text-sm leading-6 text-[var(--ink)] outline-none transition placeholder:text-[var(--ink-soft)] focus:border-[var(--ink-soft)]"
          />

          <div className="mb-4 flex flex-col gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-left text-xs leading-5 text-[var(--ink)] transition hover:bg-[var(--surface-muted)]"
              >
                {example}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mb-3 inline-flex min-h-11 items-center text-xs font-medium text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>

          {showAdvanced && (
            <div className="mb-4 grid gap-4 rounded-lg border border-[var(--line)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
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
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--ink-soft)]"
                />
                <span className="mt-1 block font-normal leading-5">
                  Same seed and input gives the same result.
                </span>
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={() => void run()}
            disabled={status === 'running'}
            className="h-11 w-full rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === 'running' ? `Editing… ${elapsed.toFixed(1)}s` : 'Edit image'}
          </button>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-bg)] px-3 py-3 text-sm leading-6 text-[var(--danger-ink)]"
            >
              {error}
            </p>
          )}
        </section>

        <section className="panel rounded-xl p-4 sm:p-5">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-[var(--ink-soft)]">
            Result
          </h2>

          {status === 'running' && (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-10 text-center sm:min-h-80">
              <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--ink)]" />
              <p className="text-sm font-medium text-[var(--ink)]">
                Working — {elapsed.toFixed(1)}s
              </p>
              <p className="mt-1 max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                {elapsed < 30
                  ? 'If this is the first edit in a while, a GPU is starting and loading the model. About 30 seconds is normal.'
                  : 'The GPU is running now. Edits themselves take a few seconds.'}
              </p>
            </div>
          )}

          {status === 'idle' && (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-10 text-center sm:min-h-80">
              <p className="text-sm text-[var(--ink-soft)]">The edited image will appear here.</p>
            </div>
          )}

          {status === 'error' && !resultUrl && (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-10 text-center sm:min-h-80">
              <p className="text-sm text-[var(--ink-soft)]">The edit did not finish. Adjust the prompt and try again.</p>
            </div>
          )}

          {status === 'done' && resultUrl && (
            <>
              <img
                src={resultUrl}
                alt="Edited result"
                className="mb-3 max-h-[70vh] w-full rounded-lg border border-[var(--line)] bg-[var(--surface-muted)] object-contain"
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[var(--ink-soft)]">{resultMeta}</p>
                <button
                  type="button"
                  onClick={download}
                  className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--surface-muted)] sm:w-auto"
                >
                  Download PNG
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}
