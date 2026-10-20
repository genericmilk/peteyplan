/**
 * Board-tinted accent palette.
 *
 * The active board's colour drives the UI accent (buttons, links, focus rings,
 * stage track, logo, favicon). Board colours are user-picked, so every derived
 * shade is nudged until it meets WCAG contrast against the surface it sits on.
 */

type Rgb = [number, number, number]
export type AccentTheme = 'light' | 'dark'

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
/** Text colour used on light accent fills. */
const INK: Rgb = [16, 19, 26]
const ON_DARK_FILL: Rgb = [248, 250, 255]

/** Representative surfaces accent text has to read on, per theme. */
const SURFACES: Record<AccentTheme, Rgb[]> = {
  dark: [[30, 34, 44], [26, 29, 38]],
  light: [[255, 255, 255], [238, 240, 245]],
}

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Mix `base` toward `toward` in small steps until it reaches `ratio` against every surface. */
function untilReadable(base: Rgb, toward: Rgb, surfaces: Rgb[], ratio: number): Rgb {
  for (let t = 0; t <= 1; t += 0.04) {
    const c = mix(base, toward, t)
    // Small margin so rounding to hex can't drop it below the target.
    if (surfaces.every((s) => contrast(c, s) >= ratio + 0.05)) return c
  }
  return toward
}

export interface AccentPalette {
  '--accent': string
  '--accent-text': string
  '--accent-text-strong': string
  '--accent-fill': string
  '--accent-hover': string
  '--on-accent': string
  '--brand-ink': string
}

export function accentPalette(boardColor: string, theme: AccentTheme): AccentPalette | null {
  const base = parseHex(boardColor)
  if (!base) return null
  const surfaces = SURFACES[theme]
  const away = theme === 'dark' ? WHITE : BLACK

  // Button fill: keep white text if a modest darkening gets there, otherwise use dark ink.
  let fill = base
  let onAccent = ON_DARK_FILL
  let hover: Rgb
  const darkened = untilReadable(base, BLACK, [ON_DARK_FILL], 4.5)
  if (contrast(darkened, ON_DARK_FILL) >= 4.55 && luminance(base) - luminance(darkened) < 0.18) {
    fill = darkened
    hover = mix(fill, BLACK, 0.1)
  } else {
    onAccent = INK
    fill = untilReadable(base, WHITE, [INK], 4.5)
    hover = mix(fill, WHITE, 0.12)
  }

  return {
    '--accent': toHex(untilReadable(base, away, surfaces, 4.5)),
    '--accent-text': toHex(untilReadable(mix(base, away, theme === 'dark' ? 0.55 : 0.2), away, surfaces, 7)),
    '--accent-text-strong': toHex(theme === 'dark' ? mix(base, WHITE, 0.92) : untilReadable(base, BLACK, surfaces, 10)),
    '--accent-fill': toHex(fill),
    '--accent-hover': toHex(hover),
    '--on-accent': toHex(onAccent),
    '--brand-ink': toHex(untilReadable(base, away, surfaces, 3)),
  }
}
