/**
 * The product's name, title and description, in one place.
 *
 * They appear in three places that must not drift — the document head, the
 * wordmark in the header, and the social card — and a rename that only reaches
 * one of them is the usual way branding ends up half-done.
 *
 * The repository, the Modal app and the Vercel project keep the old name on
 * purpose: renaming the Modal app renames its endpoints, which would mean
 * rotating three environment variables on Vercel for a change nobody sees.
 * The name a visitor meets is the one that matters.
 */
export const BRAND = {
  name: 'Latent',
  /** Lowercase, because the wordmark is set that way everywhere. */
  wordmark: 'latent',
  title: 'Latent — describe an image, or drop a photo',
  description:
    'A photo changes; a sentence makes something new. One composer for both, Qwen-Image-2.1 on an on-demand GPU. Renders are deleted after 45 minutes.',
  url: 'https://image-editor-sooty-two.vercel.app',
} as const

/** Social cards need an absolute URL — a relative path is ignored by every scraper. */
export const SOCIAL_IMAGE = `${BRAND.url}/og.png`

export const SOCIAL_IMAGE_ALT =
  'Latent: a cartoon frog sticker on a dark card, with the words “Describe it. Or drop a photo.”'
