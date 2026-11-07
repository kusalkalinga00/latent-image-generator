# Create your own self-hosted image generator for free

### Serverless, actually — and "free" means a monthly credit. Here's the whole bill.

---

Everyone can call an image API. Paste a key, send a prompt, get a picture, write it up. That takes
twenty minutes and teaches you nothing, because somebody else solved every hard part: the GPU, the
queue, the cold start, the bill, the person who leaves the tab open.

This is the other version. You own the model weights, the inference server, the endpoint and the
UI. The only thing you rent is the GPU, by the second, and it goes to sleep when nobody is looking.
It costs me nothing a month — but it *is* where I learned what deploying a 7B image model actually
involves.

Everything below is measured on the running thing, not estimated. The repo is public and the demo
is up.

---

## What you're actually building

Three pieces, and the shape of the thing matters more than the code:

1. **A GPU service** (Modal) holding Qwen-Image-2.1 — 33.1 GiB of weights — that answers JSON.
2. **A web app** (Vercel) that owns the UI and the credential, and calls the GPU server-to-server.
3. **A bucket of finished renders**, so a phone that locks mid-render doesn't lose work you already
   paid for.

The critical design decision is #2. The browser never talks to the GPU service. It talks to a
function on Vercel, which holds the token and makes the outbound call. That's the difference
between an app and a leak: any credential the browser can reach, every visitor owns.

It's also why there's no Gradio UI bolted onto the model. A UI living inside the GPU container has
to authenticate its own users; a UI that proxies through a server doesn't, because the credential
never leaves the server.

---

## The bill, honestly

Modal's Starter plan gives **$30/month of compute** and an H100 costs **$0.001097 per second**
($3.95/hour). Two details decide whether that's a toy or a working app:

**The 60-second idle window is billed.** Containers stay alive a minute after the last request, and
you pay for that minute. A single isolated render therefore costs its work *plus* 63 seconds of
H100 — about **$0.07**, of which $0.066 is pure waiting. Batch your testing or the idle tail eats
the credit.

**One container, always.** `max_containers=1` isn't a rate limit, it's the thing that stops a burst
of traffic billing N GPUs at once.

What that buys, measured:

| | |
|---|---|
| Cold start (load 33.1 GiB, then render) | 19.3 s + 3.2–3.8 s ≈ **$0.09** |
| Warm render, in a batch | **$0.0041** |
| Renders per month, every one isolated | ~329 |
| Renders per month, batches of 20 | ~3,540 |
| Peak VRAM at 1312² | 44.1 GB |

That last number is the one that surprises people. The model is 7B parameters, modest by diffusion
standards, and it still wants 44 GB — because activations at 1312² dominate, not the weights. It
does not fit comfortably on the 48 GB L40S that costs half as much: 44.1 GB of peak against a 48 GB
card leaves no room for fragmentation, and you find out by crashing. The H100 isn't a flex. It's
the cheapest card that runs this shape of work.

---

## Five things that actually mattered

### 1. Four steps instead of forty

The single biggest cost lever, and it's a one-line install. LightX2V publishes a **4-step
distillation** of the base model — a LoRA that produces a finished image in four denoising steps
instead of forty. Same model, same output size, ~10× less compute.

But the LoRA is only half of it. A distillation carries an **implicit noise schedule**, and that
schedule is not in the LoRA file. You have to rebuild the scheduler to match how the model was
distilled:

```python
LIGHTNING_SCHEDULER_CONFIG = {
    "use_dynamic_shifting": True,
    "time_shift_type": "exponential",
    "base_shift": 0.5,
    "max_shift": 0.9,
}
SIGMAS = [1.0, 0.75, 0.5, 0.25]
```

Attach that LoRA to the pipeline's *default* scheduler and you get a faint grid over an otherwise
plausible image. It survives a glance, which is what makes it dangerous.

And here's the trap: **these numbers are not portable between model versions.** The older LoRA I
had been using wanted `log(3)` for both shifts. 2.1 wants `0.5` and `0.9`. I very nearly carried
the old block across during a migration, and nothing in the LoRA file would have stopped me —
the maths still runs, the image still appears, it just has a grid in it.

What caught it was a cheap habit worth stealing: a CPU-only function that builds the scheduler and
loads the processor *before* any GPU is rented. It costs a few cents and it fails in ten seconds
instead of producing images you find out about later.

### 2. One model, not two

My first build used two checkpoints: Edit-2511 for changing a photo, 2512 for making one from
scratch. Two classes, two containers, two cold starts — because each checkpoint was 53.7 GiB and
two of those don't fit in 80 GB of VRAM, so they could never share a process.

Qwen-Image-2.1 replaced both with one 33.1 GiB model that does either job. The API decides by a
single question — *did an image arrive with the prompt?* — and everything downstream stops
branching. One class, one cold start, one Volume, 60 GiB of storage back.

The lesson isn't "use 2.1". It's that **two models was a symptom**: I'd picked two checkpoints by
what they could do, and paid for it in every other dimension. One model that does 90% of both jobs
beat two that each did 100% of one.

### 3. Transparency is a generation parameter now

The old models were RGB. Ask for "a transparent background" and they'd *paint you a grey
checkerboard* — the visual idiom, not an alpha channel — and the alpha had to be cut out afterwards
by a second model. Mine had two methods, a u2net fallback, and a pixel of erosion to hide the grey
fringe.

2.1 emits RGBA natively, if you ask in the phrasing it was trained on:

```
This is an RGBA image with transparency. {prompt}
The image has alpha channel and the background is transparent.
```

The only post-processing left is arithmetic on one channel: the background comes back at about
1–7/255 rather than 0. Invisible on screen, a colour fringe once composited.

```python
alpha = image.getchannel("A").point(lambda v: 0 if v < 8 else v)
```

166 lines of matting code, 176 MB of extra model, and a failure mode where it amputated a leaf —
deleted by one line, because the base model changed. That's the best kind of refactor.

### 4. Vercel rejects large request bodies, and base64 is a 33% tax

This one looked like a model bug. Editing a generated result failed with "the edit did not
finish" — and the GPU service logged **no request at all**, which is the tell I should have
noticed sooner.

The fetch was a **413**. Vercel caps a serverless request body at 4.5 MB. The 2.1 PNGs are ~3.7 MB,
base64 adds a third, and 4.89 MB went out against a 4.5 MB ceiling. Nothing reached my code to
fail; the platform refused the request before the function ran.

The fix was encoding in the browser instead of shipping the PNG:

```js
// WebP keeps alpha and is ~10× smaller for this kind of output:
// 3.7 MB PNG -> 359 KB WebP, for the same render.
const dataUrl = canvas.toDataURL('image/webp', 0.92)
```

Same edit now posts 479 KB and returns in 3.8 s. **Lesson: when nothing arrives, stop reading your
own logs and read the network panel.** A missing request is a different bug from a failed one.

### 5. A lost reply is not a lost render

Lock your phone mid-render and iOS kills the fetch. The GPU, which nobody told, finishes the
render, bills you for it, and the user sees a network error.

The fix costs one small write: the client picks a **job id** before it sends anything, the backend
stores the finished payload under that id, and there's a second endpoint that hands it back. On
resume, the client asks "is there a render under this id?" instead of starting another one. The
result is 45 minutes of recoverable work instead of a double bill.

```json
{ "ok": true, "pending": true }
```

That's the whole contract. Pending means wait, don't retry.

---

## The mobile bug nobody warns you about

`<a download>` is a no-op in iOS Safari when the href is a `data:` URL. The click does nothing and
your "Download started" toast is a lie.

So I used the share sheet — the only route from a web page into Photos. Then a Mac user clicked
Download and got a menu of AirDrop, Messages and Notes, because I'd gated the share sheet on this:

```js
navigator.canShare({ files: [file] })   // true on desktop Chrome and Safari too
```

That answers *"could this browser share a file"*, not *"must it"*. The correct gate is the platform:

```js
const ios = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
```

**Capability is not requirement.** That distinction cost me a real bug here, and it's worth
watching for anywhere an API answers "can you?" when you meant to ask "should you?".

---

## What it costs to look free

Two asterisks, both of which match:

- **Vercel Hobby** is free for non-commercial personal projects.
- **Qwen-Image-2.1** is under the **Qwen Research Licence** — non-commercial use, defined as
  research or evaluation. Commercial use needs a separate licence from Qwen.
- The 4-step LoRA declares **no licence at all**. It's a derivative of a research-licensed base, so
  the base terms are what bind. Absent is not permission.

So the free path and the legal path are the same path: a personal project that nobody pays for.
The moment you charge for it, you break three things at once.

If you skipped that section, go back. It's the only part of this article that can get you in
trouble.

---

## If I started today

1. **Pick one model that does both jobs.** Two checkpoints means two cold starts forever.
2. **Find the distilled LoRA first.** 4 steps vs 40 is the difference between $30/month and
   $300/month. Copy its scheduler *from the model card for your version*, not from a blog post.
3. **Put the credential behind a server function.** No `VITE_` prefix, ever.
4. **Cap concurrency at 1** before you share the link, not after.
5. **Rate limit per address in the backend**, not in the web process — serverless instances are
   recycled, and a counter that resets on cold start isn't a limit.
6. **Give every render a job id.** It's one write and it turns a bug into a feature.
7. **Measure one cold start and one warm render before writing any pricing claim.**

The whole thing is about 4,800 lines: a React app, a Modal service, and a Docker image
definition.
The interesting part was never the model. It was everything around it — the 4.5 MB ceiling, the
billed idle minute, the share sheet that opens where you least expect it.

---

*Repo: `github.com/kusalkalinga00/latent-image-generator` · the demo runs on a $30/month credit, so
please don't loop it.*
