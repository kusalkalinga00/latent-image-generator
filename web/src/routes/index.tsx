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
    <main className="page-wrap px-4 pb-16 pt-10">
      <section className="mb-8 max-w-3xl">
        <p className="island-kicker mb-2">Qwen-Image-Edit-2511 · 4-step distilled</p>
        <h1 className="display-title mb-3 text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
          Edit a photo by describing the change
        </h1>
        <p className="text-base text-[var(--sea-ink-soft)] sm:text-lg">
          Runs on a dedicated GPU that shuts down when idle. The first edit of a
          session takes about half a minute while the model loads; after that, edits
          take a few seconds.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- input ---------------- */}
        <section
          className="island-shell rounded-3xl p-5 sm:p-6"
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
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            1 · Your image{attachments.length ? `s (${attachments.length}/${MAX_IMAGES})` : ''}
          </h2>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={attachments.length >= MAX_IMAGES}
            className={`mb-3 flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${
              dragging
                ? 'border-[var(--lagoon)] bg-[rgba(79,184,178,0.12)]'
                : 'border-[var(--line)] hover:border-[var(--lagoon)] hover:bg-[rgba(79,184,178,0.06)]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span className="text-2xl">🖼️</span>
            <span className="mt-2 text-sm font-semibold text-[var(--sea-ink)]">
              {attachments.length >= MAX_IMAGES
                ? `That is all ${MAX_IMAGES} images`
                : 'Drop images here or click to choose'}
            </span>
            <span className="mt-1 text-xs text-[var(--sea-ink-soft)]">
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
            <ul className="mb-4 grid grid-cols-3 gap-2">
              {attachments.map((a) => (
                <li
                  key={a.id}
                  className="group relative overflow-hidden rounded-xl border border-[var(--line)]"
                >
                  <img src={a.previewUrl} alt={a.name} className="h-24 w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.name}`}
                    className="absolute right-1 top-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-bold text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            2 · What should change?
          </h2>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Make the sky a dramatic sunset and keep the subject unchanged"
            className="mb-3 w-full resize-y rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
          />

          <div className="mb-4 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.1)] px-3 py-1 text-xs font-medium text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.2)]"
              >
                {example}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mb-3 text-xs font-semibold text-[var(--lagoon-deep)] underline"
          >
            {showAdvanced ? 'Hide' : 'Show'} advanced
          </button>

          {showAdvanced && (
            <div className="mb-4 grid grid-cols-2 gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
              <label className="text-xs font-semibold text-[var(--sea-ink-soft)]">
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
                <span className="mt-1 block font-normal">
                  4 is the distilled default. Above 4 uses the slower standard path.
                </span>
              </label>
              <label className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                Seed
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  className="mt-2 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-sm"
                />
                <span className="mt-1 block font-normal">
                  Same seed and input gives the same result.
                </span>
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={() => void run()}
            disabled={status === 'running'}
            className="w-full rounded-full bg-[var(--lagoon-deep)] px-6 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === 'running' ? `Editing… ${elapsed.toFixed(1)}s` : 'Edit image'}
          </button>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {error}
            </p>
          )}
        </section>

        {/* ---------------- output ---------------- */}
        <section className="island-shell rounded-3xl p-5 sm:p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            3 · Result
          </h2>

          {status === 'running' && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--line)] px-4 py-16 text-center">
              <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--lagoon-deep)]" />
              <p className="text-sm font-semibold text-[var(--sea-ink)]">
                Working on it — {elapsed.toFixed(1)}s
              </p>
              <p className="mt-1 max-w-xs text-xs text-[var(--sea-ink-soft)]">
                {elapsed < 30
                  ? 'If this is the first edit in a while, a GPU is starting and loading the model. About 30 seconds is normal.'
                  : 'The GPU is running now; edits themselves take a few seconds.'}
              </p>
            </div>
          )}

          {status === 'idle' && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--line)] px-4 py-16 text-center">
              <span className="text-2xl">✨</span>
              <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
                Your edited image will appear here.
              </p>
            </div>
          )}

          {status === 'done' && resultUrl && (
            <>
              <img
                src={resultUrl}
                alt="Edited result"
                className="mb-3 w-full rounded-2xl border border-[var(--line)]"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-[var(--sea-ink-soft)]">{resultMeta}</p>
                <button
                  type="button"
                  onClick={download}
                  className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-xs font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)]"
                >
                  Download PNG
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <p className="mt-8 max-w-2xl text-xs text-[var(--sea-ink-soft)]">
        Images are sent to a GPU for processing and are not stored. The model is
        Qwen-Image-Edit-2511 running on Modal, distilled to 4 steps.
      </p>
    </main>
  )
}
