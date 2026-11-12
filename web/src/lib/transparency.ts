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

export function wantsTransparent(prompt: string): boolean {
  return WANTS_TRANSPARENT.test(prompt)
}
