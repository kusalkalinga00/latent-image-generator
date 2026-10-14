# Cost

Modal bills per second of actual compute. There is no idle charge, which is what
makes a $30/month credit viable for a 20B image model — but only if the design
respects it.

## Rates (verified)

From Modal's pricing page, per second and per derived hour:

| Resource | Per second | Per hour |
|---|---|---|
| H100 SXM5 (80 GB) | $0.001097 | $3.95 |
| A100 80 GB | $0.000694 | $2.50 |
| A100 40 GB | $0.000583 | $2.10 |
| L40S (48 GB) | $0.000542 | $1.95 |
| B200 (180 GB) | $0.001736 | $6.25 |
| CPU | — | $0.047 / physical core |
| Memory | — | $0.008 / GiB |
| Volume storage | — | $0.09 / GiB-month, **first 1 TiB free** |

The Starter plan includes **$30/month of compute**. Storage for a 57.7 GB
checkpoint therefore costs **$0.00** — it sits three orders of magnitude under the
free allowance.

## What $30 buys

| GPU | GPU-hours | Roughly |
|---|---|---|
| L40S 48 GB | 15.4 hr | |
| A100 40 GB | 14.3 hr | |
| A100 80 GB | 12.0 hr | |
| **H100 80 GB** | **7.6 hr** | this app |
| B200 180 GB | 4.8 hr | |

7.6 H100-hours per month is roughly **15 minutes of GPU time per day**. That is
generous for personal use and thin for anything shared, which sets the design.

## The only thing that matters: how long the GPU is alive

Three decisions, each load-bearing:

1. **`max_containers=1`** — a personal tool must never run two H100s at once. Two
   concurrent requests would otherwise double a bill silently.
2. **`scaledown_window=60`** — release the GPU a minute after the last edit.
3. **The Gradio UI runs on a CPU-only container**, calling the GPU over Modal RPC.

Decision 3 is the non-obvious one, and it is worth the paragraph. If the UI lived
in the same container as the model, then merely *having the page open* would keep
an H100 alive — you would be paying $3.95/hr while reading a result, or while the
tab sat forgotten in the background. Serving the UI from a CPU container means the
GPU is alive only while it is actually denoising. The idle browser tab costs
cents instead of dollars.

### Cost of holding a GPU warm

| Kept warm | Per month |
|---|---|
| 1 × H100 | **$2,848** |
| 1 × L40S | $1,424 |
| 1 × A100 80 GB | $1,825 |

All of these exceed the $30 credit by 47×–95×. **Scale-to-zero is not a
preference here, it is the only configuration that fits the budget.**

## What it costs per edit

Measured on an H100 with `inputs/ref.png` (896×1184, 40 steps):

| Phase | Measured |
|---|---|
| Container boot | ~1–2 s (Modal's claim; not separately instrumented) |
| Load 53.76 GiB of weights into VRAM | **28.6 s** |
| 40-step edit at 896×1184 | **33.5 s** |
| **First edit of a session** | **~62 s → $0.068** |
| **Each further edit while warm** | **~34 s → $0.037** |

At those rates $30/month is roughly:

| Usage pattern | Edits per month |
|---|---|
| Every edit a cold start | ~440 |
| Warm batches of 5 | ~700 |
| Warm batches of 20 | ~780 |

That is the honest shape of it: **cold starts are about half the cost of a single
edit**, which is why batching several edits into one sitting roughly halves the
per-edit price. The load is paid once per container, not once per edit.

The `pipeline on GPU in 28.6s` line is logged on every cold start, so this number
is checkable rather than remembered.

### The cost of the debugging that got us here

Two failed H100 attempts (a missing `torchvision`, then a crash-loop against a
stale deployment) plus one successful run. The crash-loop is the one worth
knowing about: a container that repeatedly fails to start still bills for the
seconds it runs, so a loop that *looks* like a slow cold start is quietly
spending money. It was caught and the deployment replaced, but the pattern is
worth recognising. Exact spend is in the Modal dashboard, not here.

## Cheaper configurations, if you need more headroom

In rough order of effect:

| Change | Effect | Cost |
|---|---|---|
| Fewer steps (40 → 20) | ~halves per-edit GPU time | Some prompt-adherence loss |
| Use `Qwen-Image-Lightning` LoRA | 4 steps instead of 40 — the single biggest lever | Distilled; mild quality trade |
| L40S instead of H100 | $1.95/hr vs $3.95 — 2× the hours | Slower per step; 48 GB needs an FP8 quant of the 40 GB transformer |
| A100 80 GB | $2.50/hr vs $3.95 | ~40% slower than H100 |

`Qwen-Image-Lightning` is worth knowing about: it is linked from Qwen's own
repository and claims a 25× reduction in DiT NFEs. It is not wired in here because
it changes output quality, and this app is meant to be the reference
configuration first.

## Watching the spend

Modal's dashboard shows per-app GPU-seconds and cost. Two useful checks:

```sh
# what the Volume holds (free, but proves the cache is intact)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::volume_stats

# recent app runs and their durations
uv run --package modal-app modal app list
```

A runaway bill in this design can only come from one of two things: `max_containers`
being raised, or something keeping a container busy. Both are visible in the app's
Containers tab, and both are worth checking before blaming the model.

## A note on the plan we are on

Starter includes $30/month, 3 seats, 100 containers, 10 GPU concurrency, and 1-day
log retention. **The 1-day log retention is the one limitation that matters** for
debugging a failed edit a week later — the logs are gone. Persisting anything
important to the Volume (or to the repo) is the workaround.
