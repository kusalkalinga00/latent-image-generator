# Model weights: not covered by this repository's MIT licence

`LICENSE` at the root of this repository is MIT and covers **the application code
only** — the React app, the Modal service, the scripts and the docs.

The model weights it runs are separate works with their own terms:

| Work | Licence | Commercial use |
|---|---|---|
| [`Qwen/Qwen-Image-2.1`](https://huggingface.co/Qwen/Qwen-Image-2.1) | Qwen Research Licence Agreement | **No** — a separate licence is required |
| [`lightx2v/Qwen-Image-2.1-Lightning`](https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning) | None declared | Nothing may be assumed |

The Qwen agreement grants use, reproduction, modification and redistribution for
non-commercial purposes only, defining non-commercial as *research or evaluation*.
Commercial use requires a licence requested from Qwen. Redistribution carries
conditions too: pass the agreement along with the weights, and mark any files you
changed.

The Lightning LoRA declares no licence at all — no `license` field on its model
card, no `LICENSE` file, no licence sentence in its README. It is a derivative
adapter of the research-licensed base model, so the base model's terms are what
bind. An absent licence is not permission.

Neither repository is gated, so no Hugging Face token is needed to run any of this.

**Read the model card, not this file.** Terms change between releases: the
checkpoints this project replaced (Edit-2511 and 2512) were Apache 2.0, which is
how an out-of-date line of documentation becomes a compliance problem.
