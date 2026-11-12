import { createFileRoute } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import { refreshCredit } from '#/lib/credit-store'
import {
  ASPECT_LABELS,
  collectResult,
  editImage,
  generateImage,
} from '#/lib/edit'
import type { Aspect, EditOutput } from '#/lib/edit'
import { pushToast } from '#/lib/toast'

export const Route = createFileRoute('/')({ component: App })

const MAX_IMAGES = 4
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_EDGE = 1536 // the model works around 1.5MP; larger just costs GPU seconds
// Vercel rejects a serverless request body over 4.5MB with a 413 before the code
// runs. Base64 inflates an image by 4/3, so the *total* encoded size across every
// attachment has to stay under this, with room for the JSON around it. A per-image
// cap is not enough: four images at the old cap were 13.6MB of base64.
const MAX_TOTAL_ATTACHMENT_CHARS = 3_400_000
// Below this an image is too small to be worth sending; shrinking further is a
// worse answer than asking the user to remove one.
const MIN_ATTACHMENT_CHARS = 64_000

// The backend holds one model - Qwen-Image-2.1 with the 4-step Lightning LoRA - and
// it does both generation and editing. There is no second "standard" path to switch
// to, so steps are not a choice the UI can offer; passing 4 is the honest thing to
// send.
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
 * Does the prompt ask for an image with no background?
 *
 * These are phrases about the *output* file, not about anything inside the
 * picture, and the distinction is load-bearing now that transparency is a
 * generation parameter rather than a post-step: a match here rewrites the request
 * so the model spends its four steps drawing an alpha channel. A bare
 * "transparent" used to be a harmless false positive — it produced a cutout from
 * an otherwise normal render — but "a transparent glass of water" would now come
 * back as a cutout of a glass instead of the photograph the user asked for. So
 * "transparent" only counts when it is about the background.
 */
const WANTS_TRANSPARENT =
  /\btransparent\s+(background|bg)\b|\brgba\b|\balpha\s+channel\b|\bwith\s+alpha\b|\bcut\s?-?out\b|\bno\s+background\b|remove\s+(the\s+)?background|\bplain\s+(white|solid)\s+background\b|isolated\s+on\s+(white|plain)/i

/**
 * The transparency control, in two dresses: an icon inside the pill on wide
 * screens, a labelled chip in its own row on phones, where a third icon beside a
 * short field was both crowded and indistinguishable from the shape control next
 * to it.
 *
 * It asks the model for an alpha channel rather than cutting anything out, so it
 * is labelled for what it produces.
 */
function TransparentControl({
  on,
  chip,
  disabled,
  title,
  onToggle,
}: {
  on: boolean
  chip: boolean
  disabled: boolean
  title: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={`${chip ? 'chip-toggle' : 'icon-toggle'}${on ? ' is-on' : ''}`}
      onClick={onToggle}
      aria-pressed={on}
      aria-label="Transparent background"
      title={title}
      disabled={disabled}
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
        <path d="M6.2 6.2h5.8v5.8H6.2zM12 12h5.8v5.8H12z" fill="currentColor" />
      </svg>
      {chip && <span>Transparent</span>}
    </button>
  )
}

function ShapeControl({
  value,
  onChange,
}: {
  value: Aspect
  onChange: (next: Aspect) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // A native <select> cannot be styled and its popup is placed by the OS — on a
  // phone it landed over the headline, far from the control that opened it. This
  // is the same list, drawn where it belongs.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const options = Object.keys(ASPECT_LABELS) as Aspect[]

  return (
    <div className="shape" ref={wrap}>
      <button
        type="button"
        className="shape-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Image shape: ${ASPECT_LABELS[value]}`}
        onClick={() => setOpen((was) => !was)}
      >
        <span>{ASPECT_LABELS[value]}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul className="shape-menu" role="listbox" aria-label="Image shape">
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                className={`shape-choice${option === value ? ' is-on' : ''}`}
                onClick={() => {
                  onChange(option)
                  setOpen(false)
                }}
              >
                <ShapeGlyph aspect={option} />
                <span>{ASPECT_LABELS[option]}</span>
                {option === value && (
                  <svg
                    className="shape-check"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 12.5l4.5 4.5L19 7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** localStorage key for a render that is still owed to this device. */
const PENDING_KEY = 'image-editor:pending'

interface PendingJob {
  id: string
  prompt: string
  mode: 'edit' | 'generate'
  at: number
}

/** The aspect, drawn to scale — a word says "Wide", this shows how wide. */
function ShapeGlyph({ aspect }: { aspect: Aspect }) {
  const [w, h] = aspect.split(':').map(Number)
  const long = 14
  const width = w >= h ? long : (long * w) / h
  const height = h >= w ? long : (long * h) / w
  return (
    <svg
      className="shape-glyph"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x={(16 - width) / 2}
        y={(16 - height) / 2}
        width={width}
        height={height}
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

/**
 * Is this the one platform where a web page cannot save a file by itself?
 *
 * iOS Safari ignores `<a download>` on a data: URL — the tap is a no-op — so the
 * share sheet is the only route from a page to Photos, and it only opens from
 * inside the tap gesture.
 *
 * Everywhere else the share sheet is the *wrong* answer, which is what made
 * "Download" look broken on a Mac: `navigator.canShare({ files })` is true in
 * desktop Chrome and Safari too, so the button opened a menu of AirDrop, Messages
 * and Notes instead of saving anything. The capability test never distinguished
 * "can share" from "must share".
 */
function needsShareSheet(): boolean {
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true
  // iPadOS 13+ reports itself as a Mac; the touch count is what gives it away.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/**
 * A data: URL as a File, decoded synchronously.
 *
 * `navigator.share()` has to be called while the tap gesture is still live, so the
 * base64 cannot be decoded through `fetch(dataUrl)` — that await loses the gesture
 * on iOS and the sheet never opens.
 */
function dataUrlToFile(dataUrl: string, name: string): File | null {
  const comma = dataUrl.indexOf(',')
  if (comma === -1 || !dataUrl.slice(0, comma).includes('base64')) return null
  try {
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name, { type: 'image/png' })
  } catch {
    return null
  }
}

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
 * Encode a canvas small enough to survive the trip to the server.
 *
 * WebP first: it keeps the alpha channel and comes back roughly a tenth the size
 * of a PNG for photographic output — a 1312px render is 3.7MB as PNG and 359KB as
 * WebP. Browsers that will not encode it fall back to PNG.
 */
function encodeCanvas(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL('image/webp', 0.92)
  if (webp.startsWith('data:image/webp')) return webp
  return canvas.toDataURL('image/png')
}

/**
 * Downscale in the browser before upload.
 *
 * Three practical reasons, and the third one only became true when the model
 * changed: the model works around 1.5MP so extra resolution buys nothing but GPU
 * seconds; Vercel Functions cap a request body at **4.5MB**; and the transparent,
 * higher-detail PNGs Qwen-Image-2.1 returns are large enough to hit that cap on
 * their own. Editing a generated result sent 4.89MB of base64 and was rejected with
 * a 413 before the server function ever ran — which the app could only report as
 * "the edit did not finish". So the encoded size is enforced here, not assumed.
 */
async function prepareImage(
  file: File,
  budgetChars = MAX_TOTAL_ATTACHMENT_CHARS,
): Promise<Attachment> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the 20MB limit`,
    )
  }
  if (budgetChars < MIN_ATTACHMENT_CHARS) {
    throw new Error('There is no room for another image. Remove one first.')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${file.name} could not be read. Try a different image.`)
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  let width = Math.max(1, Math.round(bitmap.width * scale))
  let height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Could not process that image in this browser')
  }

  let dataUrl = ''
  for (let attempt = 0; ; attempt += 1) {
    canvas.width = width
    canvas.height = height
    ctx.drawImage(bitmap, 0, 0, width, height)
    dataUrl = encodeCanvas(canvas)
    const chars = dataUrl.length - dataUrl.indexOf(',') - 1
    if (chars <= budgetChars) break
    if (attempt >= 5) {
      bitmap.close()
      throw new Error(
        `${file.name} is too detailed to send with the images already attached. Remove one or try a smaller image.`,
      )
    }
    width = Math.max(1, Math.round(width * 0.8))
    height = Math.max(1, Math.round(height * 0.8))
  }
  bitmap.close()

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
  const label = WAIT_PHASES[mode][phase]

  // The grid used to be 26 columns flat, which is 429px of dots and gap: wider
  // than a 375px phone, and it dragged the whole thread — and the prompt bubble
  // in it — off the right edge. The column count now comes from the space that
  // exists, and the dots rendered follow it, so the field always fits and the
  // percentage still means what it says.
  // Start conservative: a wide first guess is what overflowed the phone before
  // the measurement lands, and the measure happens in a layout effect anyway.
  const [cols, setCols] = useState(12)
  const blockRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = blockRef.current
    if (!el) return
    const fit = () => {
      // --dot and --gap are declared on .matrix, not on the block, and the width
      // that matters is the thread's — the block is stretched to it but the grid
      // inside is what used to push it wide.
      const grid = el.querySelector('.matrix') ?? el
      const styles = getComputedStyle(grid)
      const dot = Number.parseFloat(styles.getPropertyValue('--dot')) || 4
      const gap = Number.parseFloat(styles.getPropertyValue('--gap')) || 15
      const width = (el.parentElement ?? el).clientWidth
      setCols(Math.max(6, Math.floor((width + gap) / (dot + gap))))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el.parentElement ?? el)
    return () => observer.disconnect()
  }, [])

  const total = cols * DOT_ROWS
  const filled = Math.round((total * progress) / 100)

  return (
    <div className="matrix-block" ref={blockRef}>
      <p className="matrix-caption">
        {label} · {elapsed.toFixed(0)}s
      </p>
      <div className="matrix-field">
        <div
          className="matrix"
          style={{ '--cols': cols } as CSSProperties}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`${label}, ${progress}%`}
        >
          {Array.from({ length: total }, (_, index) => {
            const rank = DOT_ORDER[index % DOT_ORDER.length]
            return (
              <i key={index} className={rank < filled ? 'on' : undefined} />
            )
          })}
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
  // 2.1 can emit real alpha, so this asks the model for it in the prompt the
  // backend builds, and `resultAlpha` records whether an alpha channel actually
  // came back - the field reports what happened, not what was asked.
  //
  // Default is "decide from the prompt", because a prompt that asks for a
  // transparent background should not require finding an 18-pixel icon. A click
  // sets an explicit override for the session, in either direction; reloading
  // returns to auto, so no stale choice can silently defeat a later prompt.
  const [transparentOverride, setTransparentOverride] = useState<
    boolean | null
  >(null)
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

  const stageRef = useRef<HTMLElement>(null)

  // When a result arrives the thread is usually taller than the stage on a phone
  // with browser toolbars, and the natural resting position is the top — which
  // leaves Download and "Edit this result" clipped below the fold.
  useEffect(() => {
    if (status !== 'done') return
    const el = stageRef.current
    if (!el) return
    const pin = () => {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
    }
    // The image is decoded after paint, so one frame is too early to measure the
    // thread; a second frame plus a short settle covers the decode.
    const first = requestAnimationFrame(() => {
      pin()
      requestAnimationFrame(pin)
    })
    const settle = window.setTimeout(pin, 250)
    return () => {
      cancelAnimationFrame(first)
      clearTimeout(settle)
    }
  }, [status, resultUrl])

  // A narrow pill cannot hold the long placeholder without wrapping it into the
  // textarea's own height, so phones get the short one. Declared before the
  // measuring effect because that effect depends on it.
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 560px)')
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Grow the prompt with its content, up to the cap in CSS.
  //
  // Also re-run on resize: the height was measured against the old width, and on a
  // phone the width changes when the keyboard opens or the device turns.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(132, el.scrollHeight)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    // the placeholder changed, so the box it needs changed too
    void document.fonts.ready.then(fit)
    return () => window.removeEventListener('resize', fit)
  }, [prompt, narrow])

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

      // The budget is shared by every attachment, not per image: the request body
      // carries all of them, and Vercel caps the body, not each part.
      const existingChars = attachments.reduce(
        (sum, item) => sum + item.base64.length,
        0,
      )
      let remaining = MAX_TOTAL_ATTACHMENT_CHARS - existingChars

      const prepared: Attachment[] = []
      for (const file of incoming.slice(0, room)) {
        if (remaining < MIN_ATTACHMENT_CHARS) {
          pushToast(
            'error',
            'Those images are too large together. Remove one or add a smaller image.',
          )
          break
        }
        try {
          const next = await prepareImage(file, remaining)
          prepared.push(next)
          remaining -= next.base64.length
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
    [attachments],
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

  /**
   * The job id is chosen here, before anything is sent, and kept in
   * localStorage. A phone that locks mid-render loses the reply but not the
   * render: this is what lets the page ask for it again on the way back.
   */
  const rememberJob = useCallback((job: PendingJob | null) => {
    try {
      if (job) localStorage.setItem(PENDING_KEY, JSON.stringify(job))
      else localStorage.removeItem(PENDING_KEY)
    } catch {
      // Private mode, quota, whatever: recovery is a nicety, not a requirement.
    }
  }, [])

  const showResult = useCallback((out: EditOutput, mode: Mode) => {
    if (!out.imageBase64) return
    warmed.current = true
    setResultUrl(`data:image/png;base64,${out.imageBase64}`)
    setResultMeta(`${out.seconds}s · ${out.steps} steps`)
    setResultModel(out.model ?? '')
    setResultAlpha(out.transparent === true)
    setStatus('done')
    void refreshCredit()
    if (out.seconds) {
      pushToast(
        'success',
        `${mode === 'generate' ? 'Generated' : 'Edit ready'} in ${out.seconds}s.`,
      )
    }
  }, [])

  /**
   * Ask the backend for a render whose reply never arrived.
   *
   * Polls rather than retrying the render: a second request would bill a second
   * GPU run for work that already happened.
   */
  const collect = useCallback(
    async (jobId: string, mode: Mode, runAtStart: number) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // The lookup itself travels the same broken path, and a server function
        // rejects in the browser rather than returning an error, so this call
        // needs its own guard: one dead attempt is not a verdict.
        let out: EditOutput = { ok: false, network: true }
        try {
          out = await collectResult({ data: { jobId } })
        } catch {
          out = { ok: false, network: true }
        }
        if (runId.current !== runAtStart) return true

        if (out.ok && out.imageBase64) {
          showResult(out, mode)
          rememberJob(null)
          pushToast('info', 'Picked up the render from before.')
          return true
        }
        if (!out.pending && !out.network) {
          rememberJob(null)
          return false
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      return false
    },
    [rememberJob, showResult],
  )

  // Coming back from a lock, a reload, or a tab that was killed: the render this
  // device asked for may already be finished and waiting to be collected.
  const recoveredOnce = useRef(false)
  useEffect(() => {
    if (recoveredOnce.current) return
    recoveredOnce.current = true

    let raw: string | null = null
    try {
      raw = localStorage.getItem(PENDING_KEY)
    } catch {
      return
    }
    if (!raw) return

    let job: PendingJob
    try {
      job = JSON.parse(raw) as PendingJob
    } catch {
      rememberJob(null)
      return
    }
    if (!job.id || Date.now() - job.at > 30 * 60 * 1000) {
      rememberJob(null)
      return
    }

    void (async () => {
      const pendingRun = ++runId.current
      setPrompt(job.prompt)
      setLastPrompt(job.prompt)
      setLastMode(job.mode)
      setErrorText('')
      setStatus('running')
      const found = await collect(job.id, job.mode, pendingRun)
      // Recovered or not, that prompt has been sent — leave the field empty.
      if (found) setPrompt('')
      if (!found && runId.current === pendingRun) {
        setStatus('idle')
        pushToast('info', 'That render is no longer available.')
      }
    })()
  }, [collect, rememberJob])

  const run = async () => {
    if (!prompt.trim()) {
      pushToast('error', 'Describe what you want.')
      return
    }
    if (statusRef.current === 'running') return

    const id = ++runId.current
    const instruction = prompt.trim()
    const mode = attachments.length > 0 ? 'edit' : 'generate'
    const jobId = crypto.randomUUID()
    rememberJob({ id: jobId, prompt: instruction, mode, at: Date.now() })
    setElapsed(0)
    setErrorText('')
    setLastPrompt(instruction)
    setLastMode(mode)
    setStatus('running')
    // The prompt is echoed above the result, so the field is free as soon as it
    // is sent — and the next thought can be typed without clearing anything.
    setPrompt('')

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
                jobId,
              },
            })
          : await generateImage({
              data: {
                prompt: instruction,
                steps: STEPS,
                seed,
                aspect,
                transparent,
                jobId,
              },
            })

      if (runId.current !== id) return

      if (!out.ok || !out.imageBase64) {
        // A lost connection is not a lost render: try to collect it before
        // telling the user anything went wrong.
        if (out.network && (await collect(jobId, mode, id))) return

        // Anything else is a definitive refusal - validation, rate limit, or a
        // model failure - and nothing was stored under this id. Keeping it would
        // make the next reload poll for a render that never existed.
        if (!out.network) rememberJob(null)

        const message =
          out.error ?? 'The edit did not finish. Try again in a moment.'
        setPrompt(instruction)
        pushToast('error', message)
        setErrorText(message)
        setStatus('error')
        return
      }

      rememberJob(null)
      showResult(out, mode)
    } catch (err) {
      if (runId.current !== id) return
      // The fetch died, but that says nothing about the render: the server may
      // have finished it and stored it under the id we sent. Ask before failing.
      if (await collect(jobId, mode, id)) return

      const message =
        err instanceof Error ? err.message : 'The edit did not finish.'
      setPrompt(instruction)
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
    // Starting over also gives up the claim on any render still in flight.
    rememberJob(null)
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
    const name = `${resultAlpha ? 'transparent' : 'edited'}-${Date.now()}.png`

    // Decoded synchronously so the iOS branch below can still call share() inside
    // the tap gesture; elsewhere it doubles as the Blob behind the download.
    const file = dataUrlToFile(resultUrl, name)

    if (
      file &&
      needsShareSheet() &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] })
    ) {
      navigator
        .share({ files: [file] })
        .then(() =>
          pushToast(
            'success',
            // Photos flattens alpha onto a background, so say which door keeps it.
            resultAlpha
              ? 'Saved. Use Save to Files to keep the transparency.'
              : 'Saved to your device.',
          ),
        )
        .catch((error: unknown) => {
          // Cancelling the sheet is not a failure worth shouting about.
          if (error instanceof Error && error.name === 'AbortError') return
          pushToast('error', 'Could not open the share sheet.')
        })
      return
    }

    // An object URL, not the data: URL. Safari has ignored `download` on data: URLs
    // long enough that relying on it is a coin flip, and a Blob URL is what every
    // browser treats as an ordinary file.
    const href = file ? URL.createObjectURL(file) : resultUrl
    const a = document.createElement('a')
    a.href = href
    a.download = name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoking immediately can cancel the save in some browsers; a few seconds is
    // long enough for the download to have started reading.
    if (file) setTimeout(() => URL.revokeObjectURL(href), 10_000)
    pushToast('success', 'Download started.')
  }

  runRef.current = () => {
    void run()
  }

  const preview = attachments[0]?.previewUrl ?? ''
  const promptWantsTransparent = WANTS_TRANSPARENT.test(prompt)
  const transparent = transparentOverride ?? promptWantsTransparent
  const transparentTitle = transparent
    ? transparentOverride === null
      ? 'Your prompt asks for a transparent background, so the result will have one. Click to keep the background.'
      : 'Transparent background (PNG with alpha). Click to keep the background.'
    : promptWantsTransparent
      ? 'Turned off for this prompt, though it asks for a transparent background. Click to make it transparent.'
      : 'Make the background transparent'
  const running = status === 'running'
  const full = attachments.length >= MAX_IMAGES
  const done = status === 'done' && Boolean(resultUrl)

  return (
    <>
      <main
        ref={stageRef}
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

                  {/* On phones the actions ride on the picture instead of taking
                   * three lines of height below it. Transparent, so the image
                   * stays the subject; they are the only chrome over it. */}
                  {done && narrow && (
                    <div className="frame-actions">
                      <button
                        type="button"
                        className="frame-btn"
                        onClick={download}
                        aria-label="Download PNG"
                        title="Download PNG"
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 4v10m0 0 4.2-4.2M12 14l-4.2-4.2M5 19h14"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="frame-btn"
                        onClick={() => void continueFromResult()}
                        aria-label="Edit this result"
                        title="Edit this result"
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M4 20h4l9.5-9.5a2.1 2.1 0 0 0-3-3L5 17v3z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="frame-btn"
                        onClick={clearEditor}
                        aria-label="Start over"
                        title="Start over"
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M4 10a8 8 0 1 1 2.4 5.7M4 4v6h6"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
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
                    {!narrow && (
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
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <section className="empty">
            <h1>
              {narrow
                ? 'Describe an image, or add a photo'
                : 'Describe an image, or drop a photo'}
            </h1>
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

        {narrow && (
          <div className="composer-tools">
            {attachments.length === 0 && !running && (
              <ShapeControl value={aspect} onChange={setAspect} />
            )}
            <TransparentControl
              chip
              on={transparent}
              disabled={running}
              title={transparentTitle}
              onToggle={() => setTransparentOverride(!transparent)}
            />
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
                : narrow
                  ? 'Describe an image…'
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

          {!narrow && (
            <TransparentControl
              chip={false}
              on={transparent}
              disabled={running}
              title={transparentTitle}
              onToggle={() => setTransparentOverride(!transparent)}
            />
          )}

          {!narrow && attachments.length === 0 && !running && (
            <ShapeControl value={aspect} onChange={setAspect} />
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
          Qwen-Image ·{narrow ? ' ' : ' on-demand GPU · '}
          <b>images are not stored</b>
          {transparent && ' · transparent'}
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
