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
  const stageImage = status === 'done' && resultUrl ? resultUrl : preview
  const stageLabel = status === 'done' && resultUrl ? 'Edited' : preview ? 'Original' : ''

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

        <section
          className="stage-wrap rise"
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
          <div className={`stage-frame${dragging ? ' is-hot' : ''}${stageImage ? '' : ' is-empty'}`}>
            {stageImage ? (
              <img
                src={stageImage}
                alt={status === 'done' ? 'Edited result' : attachments[0]?.name ?? 'Selected image'}
                className="stage-image"
              />
            ) : (
              <button type="button" className="stage-empty" onClick={() => inputRef.current?.click()}>
                <span className="text-sm font-medium">Drop a photo here, or tap to choose</span>
                <span className="max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                  Up to {MAX_IMAGES} images. Add more than one to combine subjects.
                </span>
              </button>
            )}

            {stageLabel && status !== 'running' && <span className="stage-badge">{stageLabel}</span>}

            {status === 'running' && (
              <div className="stage-veil">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--ink)]" />
                <p className="text-sm font-medium text-[var(--ink)]">Working — {elapsed.toFixed(1)}s</p>
                <p className="max-w-xs text-xs leading-5 text-[var(--ink-soft)]">
                  {elapsed < 30
                    ? 'If this is the first edit in a while, a GPU is starting and loading the model. About 30 seconds is normal.'
                    : 'The GPU is running. The edit itself takes a few seconds.'}
                </p>
              </div>
            )}

            {status === 'done' && resultUrl && (
              <div className="stage-toolbar">
                <span className="rounded-full bg-slate-950/55 px-3 py-1 text-[11px] text-white backdrop-blur-sm">
                  {resultMeta}
                </span>
                <button type="button" onClick={download} className="btn-quiet h-9 px-3 text-xs font-medium">
                  Download PNG
                </button>
              </div>
            )}
          </div>

          <div className="filmstrip">
            {attachments.map((a) => (
              <div key={a.id} className="film-card">
                <img src={a.previewUrl} alt={a.name} />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="film-remove"
                >
                  ×
                </button>
              </div>
            ))}
            {attachments.length < MAX_IMAGES && (
              <button
                type="button"
                className="film-add btn-quiet"
                onClick={() => inputRef.current?.click()}
                aria-label="Add an image"
              >
                +
              </button>
            )}
          </div>
        </section>

        <aside className="command rise rise-late">
          <h2 className="m-0 mb-3 text-sm font-medium tracking-tight text-[var(--ink)]">
            What should change?
          </h2>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Make the sky a dramatic sunset and keep the subject unchanged"
            className="field mb-2"
          />

          <div className="mb-3 flex flex-col">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => setPrompt(example)} className="chip">
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
            <div className="mb-4 grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]/50 p-4">
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
            <p
              role="alert"
              className="mt-3 rounded-xl border border-[var(--danger-line)] bg-[var(--danger-bg)] px-3 py-3 text-sm leading-6 text-[var(--danger-ink)]"
            >
              {error}
            </p>
          )}
        </aside>
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
