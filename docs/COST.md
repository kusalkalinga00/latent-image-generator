# Cost

Modal bills per second of a **live container**. Two things follow that people
usually get wrong:

1. **Loading the model is billed.** A cold start is not free waiting; it is 30–70
   seconds of H100 at full rate.
2. **The idle window after the last request is billed too.** Modal's pricing FAQ:
   containers stay alive "for 60 seconds after the last inputs before we shut them
   down, which we also bill for". At H100 rates that minute costs **$0.066** — more
   than the work it preceded.

So the cost of a request is `load (if cold) + work + a minute of idle`, unless
several requests share the same minute. That one sentence explains every number
below, and it is why batching changes the monthly figure by an order of magnitude.

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

The Starter plan includes **$30/month of compute**. Both checkpoints are ~54 GiB
each (38.05 GiB transformer + 15.45 GiB text encoder), so the Volume holds ~108 GiB
— still more than an order of magnitude under the free allowance, so it costs
**$0.00**.

## What $30 buys

| GPU | GPU-hours |
|---|---|
| L40S 48 GB | 15.4 hr |
| A100 40 GB | 14.3 hr |
| A100 80 GB | 12.0 hr |
| **H100 80 GB** | **7.6 hr** — this app |
| B200 180 GB | 4.8 hr |

7.6 H100-hours per month is roughly **15 minutes of GPU time per day**. Generous for
personal use, thin for anything shared, which is what sets the design.

## The three decisions that keep it there

1. **`max_containers=1` per class** — a personal tool must never run two H100s at
   once. Two concurrent requests would otherwise double a bill silently.
2. **`scaledown_window=60`** — release the GPU a minute after the last edit.
3. **The UI is not in a GPU container.** It is a TanStack Start app on Vercel,
   calling Modal over HTTPS.

Decision 3 is the non-obvious one. If the UI lived with the model, merely *having
the page open* would keep an H100 alive — $3.95/hr while reading a result, or while
the tab sat forgotten in the background. The UI on Vercel means the GPU is alive
only while it is denoising; an idle browser tab costs nothing here.

### Cost of holding a GPU warm

| Kept warm | Per month |
|---|---|
| 1 × H100 | **$2,848** |
| 1 × L40S | $1,424 |
| 1 × A100 80 GB | $1,825 |

All of these exceed the $30 credit by 47×–95×. **Scale-to-zero is not a preference
here, it is the only configuration that fits the budget.**

## Measured

H100, one container, real runs:

| | Work | Container time | Cost |
|---|---|---|---|
| Edit, warm, in a batch | 3.6–5.3 s | work only | **$0.004** |
| Edit, warm, isolated | 3.6–5.3 s | work + 60 s idle | **$0.070** |
| Edit, cold, isolated | 31.7 s load + work | 95 s | **$0.105** |
| Generate, warm, in a batch | 3.3–3.9 s | work only | **$0.0043** |
| Generate, warm, isolated | 3.3–3.9 s | work + 60 s idle | **$0.070** |
| Generate, cold, isolated | 76.8 s wall (3.9 s denoise) | 134 s | **$0.147** |

Two measurement notes worth keeping:

- **A cold generation costs ~40% more than a cold edit** on the runs measured here
  (76.8 s wall against ~35 s), even though the two checkpoints are the same size.
  The load figures in the logs are the ones to trust, not the assumption that a
  bigger number means a bigger model.
- **The first inference on a fresh container is slower than the steady state**
  (5.29 s versus 3.61 s for the same edit) because CUDA kernels warm up. Quote the
  first number for latency, the second for throughput.

The `pipeline + 4-step LoRA on GPU in Ns` line is logged on every cold start, so the
load figure is checkable rather than remembered.

## What that means per month

| Usage pattern | Edits/month | Generations/month |
|---|---|---|
| Every request isolated (cold start each) | ~286 | ~204 |
| Batches of 5 in one sitting | ~1,240 | ~910 |
| Batches of 20 in one sitting | ~3,330 | ~2,600 |
| Marginal cost, GPU already warm | ~7,500 (**$0.004 each**) | ~7,000 (**$0.0043 each**) |

The chip in the app shows the last row, because that answers "how many more can I
do" — but it assumes a warm GPU. Plan with the batch rows. **The gap between 286 and
3,330 is entirely the 60-second idle tail**, and it is the most useful thing to know
about running this app.

## What a shared link would cost

There is no rate limit. Ten people making one edit each within a minute is one warm
container doing ten edits — cheap. The same ten spread over an hour is ten cold
starts plus ten idle minutes: roughly **$1.05 for ten edits**, and $30 lasts about a
week of casual sharing.

Before making this public, add a per-IP limit to the server function. Nothing else
in the design protects the credit.

## The cost of the debugging that got here

Failures that cost GPU time, all now checked by `check_env` on a CPU container for
cents: a missing `torchvision`, a missing `peft`, a processor that needs
`subfolder="processor"`, and a crash-loop against a stale deployment that *looked*
like a slow cold start while quietly billing. Exact spend is in the Modal dashboard,
not here.

## Cheaper configurations, if you need more headroom

| Change | Effect | Trade |
|---|---|---|
| Batch your edits | the idle minute is amortised instead of paid per request | nothing — it is free |
| `scaledown_window=10` | saves ~$0.05 per isolated request | every revisit pays a cold start |
| L40S instead of H100 | $1.95/hr vs $3.95 — twice the hours | slower per step; 48 GB needs an FP8 quant |
| A100 80 GB | $2.50/hr vs $3.95 | ~40% slower than H100 |
| 8-step LoRAs instead of 4 | — | slower per image, marginally steadier |

The 4-step distillation is already in use: against 40 steps it is **9.3× faster**
(3.61 s versus 33.53 s for the same image), and it is the single change that made a
public app viable at all.

## Watching the spend

```sh
# what the Volume holds (free, but proves the cache is intact)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::volume_stats

# recent app runs and their durations
uv run --package modal-app modal app list
```

A runaway bill in this design can only come from `max_containers` being raised,
`scaledown_window` being lengthened, or something keeping containers busy. All three
are visible in the app's Containers tab, and worth checking before blaming the model.

## A note on the plan

Starter includes $30/month, 3 seats, 100 containers, 10 GPU concurrency, and 1-day
log retention. **The 1-day log retention is the limitation that matters** when
debugging a failed edit a week later — the logs are gone. Persisting anything
important to the Volume (or to the repo) is the workaround.
