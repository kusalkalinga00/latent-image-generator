import { describe, expect, it } from 'vitest'
import { wantsTransparent } from './transparency'

describe('wantsTransparent', () => {
  it.each([
    'transparent background',
    'a transparent bg please',
    'make it rgba',
    'with alpha',
    'a cutout sticker',
    'a cut-out sticker',
    'no background',
    'remove the background',
    'remove background',
    'plain white background',
    'isolated on plain',
  ])('matches a request for an alpha output: %s', (prompt) => {
    expect(wantsTransparent(prompt)).toBe(true)
  })

  it.each([
    'a transparent glass of water',
    'a white background wall',
    'a background dancer',
    'a cut above the rest',
    'alpha rays over a lake',
  ])('does not match a subject that merely uses the words: %s', (prompt) => {
    expect(wantsTransparent(prompt)).toBe(false)
  })
})
