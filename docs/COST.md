# Cost

Modal bills per second of a **live container**. Two things follow that people
usually get wrong:

1. **Loading the model is billed.** A cold start is not free waiting; it is 19.3
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

The Starter plan includes **$30/month of compute**. The single 2.1 checkpoint is
33.1 GiB, so the Volume holds 33.1 GiB — more than an order of magnitude under the
free allowance, so it costs **$0.00**. (The previous two-checkpoint build held
93.4 GiB; the migration freed 60 GiB and removed a Volume entirely.)

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

1. **`max_containers=1`** — a personal tool must never run two H100s at once. Two
   concurrent requests would otherwise double a bill silently. With one model there
   is only one class to cap, which is the whole ceiling now.
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
| Render, warm, in a batch | 3.2–3.8 s | work only | **$0.0041** |
| Render, warm, isolated | 3.2–3.8 s | work + 60 s idle | **$0.070** |
| Render, cold, isolated | 19.3 s load + 3.7 s | 83 s | **$0.091** |
| Edit and then generate, one sitting | one load, two renders | 86.6 s | **$0.095** |

Three measurement notes worth keeping:

- **The 2.1 migration cut the cold path roughly in half** — 19.3 s of loading against
  31.7 s — because the checkpoint is 33.1 GiB instead of 53.7. Cold starts were the
  largest line item that was not the idle tail.
- **Editing and generating no longer pay separate cold starts.** Under the old
  two-checkpoint design that sequence cost about $0.15 and two 54 GiB loads; it now
  costs one load plus 3.7 s.
- **The first inference on a fresh container is slower than the steady state**
  because CUDA kernels warm up. Quote the first number for latency, the second for
  throughput.

The `2.1 + 4-step LoRA on GPU in Ns` line is logged on every cold start, so the load
figure is checkable rather than remembered.

## What that means per month

| Usage pattern | Renders/month |
|---|---|
| Every request isolated (cold start each) | ~329 |
| Batches of 5 in one sitting | ~1,395 |
| Batches of 20 in one sitting | ~3,540 |
| Marginal cost, GPU already warm | ~7,330 (**$0.0041 each**) |

The chip in the app shows the last row, because that answers "how many more can I
do" — but it assumes a warm GPU. Plan with the batch rows. **The gap between 329 and
3,540 is entirely the 60-second idle tail**, and it is the most useful thing to know
about running this app.

## What a shared link would cost

The deployed app has three guards, all enforced in the Modal API:

- **10 renders an hour per address.** Stops a loop on one connection.
- **50 renders a UTC day across the whole app.** Stops a link that reaches many
  addresses.
- **No new renders below $1 of monthly credit.** The chip is public on purpose —
  this is the free tier — but the server will not rent another H100 once the grant
  is nearly gone.

Ten people making one edit each within a minute is still one warm container doing
ten edits — cheap. The same ten spread over an hour is ten cold starts plus ten
idle minutes: roughly **$0.91 for ten renders**. The guards cap the worst case; they
do not make sharing free.

The balance is read through a five-minute cache, so a page load is a Dict read
rather than a billing API call.

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
| L40S instead of H100 | $1.95/hr vs $3.95 — twice the hours | **not possible at 1312²**: 2.1 peaks at 44.1 GB, and 60.7 GB at 2048², so a 48 GB card OOMs. Needs an FP8 quant to fit |
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
