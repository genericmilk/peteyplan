import { computed, ref, watch } from 'vue'

/** Per-browser display preferences (Settings → Appearance). */

export type ThemePref = 'system' | 'light' | 'dark'
export type MotionPref = 'snappy' | 'normal' | 'relaxed' | 'off'
export type DensityPref = 'comfortable' | 'compact'
export type SurfacePref = 'glass' | 'solid'
export type ElasticityPref = 'loose' | 'normal' | 'firm' | 'none'

export interface Preferences {
  theme: ThemePref
  motion: MotionPref
  density: DensityPref
  surface: SurfacePref
  elasticity: ElasticityPref
}

export const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Day' },
  { id: 'dark', label: 'Night' },
]

export const MOTION_OPTIONS: { id: MotionPref; label: string; factor: number }[] = [
  { id: 'snappy', label: 'Snappy', factor: 0.5 },
  { id: 'normal', label: 'Normal', factor: 1 },
  { id: 'relaxed', label: 'Relaxed', factor: 1.75 },
  { id: 'off', label: 'Off', factor: 0 },
]

export const DENSITY_OPTIONS: { id: DensityPref; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
]

export const SURFACE_OPTIONS: { id: SurfacePref; label: string }[] = [
  { id: 'glass', label: 'Glass' },
  { id: 'solid', label: 'Solid' },
]

/**
 * How the board stretches when scrolled past its edge into the next board.
 * `distance` scales how far you scroll to break through; `stretch` how far the board gives.
 * None drops the stretch and peek: a fresh scroll at the edge switches straight away.
 */
export const ELASTICITY_OPTIONS: { id: ElasticityPref; label: string; distance: number; stretch: number }[] = [
  { id: 'loose', label: 'Loose', distance: 0.6, stretch: 1.2 },
  { id: 'normal', label: 'Normal', distance: 1, stretch: 1 },
  { id: 'firm', label: 'Firm', distance: 1.6, stretch: 0.8 },
  { id: 'none', label: 'None', distance: 1, stretch: 0 },
]

/** Kept in sync with the pre-paint script in nuxt.config.ts. */
export const PREFS_STORAGE_KEY = 'peteyplan-prefs'

const DEFAULTS: Preferences = { theme: 'system', motion: 'normal', density: 'comfortable', surface: 'glass', elasticity: 'normal' }

function pick<T extends string>(value: unknown, options: { id: T }[], fallback: T): T {
  return options.some((option) => option.id === value) ? value as T : fallback
}

function readStored(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || '{}')
    return {
      theme: pick(raw.theme, THEME_OPTIONS, DEFAULTS.theme),
      motion: pick(raw.motion, MOTION_OPTIONS, DEFAULTS.motion),
      density: pick(raw.density, DENSITY_OPTIONS, DEFAULTS.density),
      surface: pick(raw.surface, SURFACE_OPTIONS, DEFAULTS.surface),
      elasticity: pick(raw.elasticity, ELASTICITY_OPTIONS, DEFAULTS.elasticity),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

const prefs = ref<Preferences>({ ...DEFAULTS })
const systemDark = ref(true)
const systemReducedMotion = ref(false)
let initialized = false

function apply() {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme.value
  root.dataset.density = prefs.value.density
  root.dataset.surface = prefs.value.surface
  root.style.setProperty('--motion', String(motionFactor.value))
}

const resolvedTheme = computed<'light' | 'dark'>(() =>
  prefs.value.theme === 'system' ? (systemDark.value ? 'dark' : 'light') : prefs.value.theme
)

/** Multiplier for animation durations; 0 when motion is off or the OS asks for reduced motion. */
const motionFactor = computed(() =>
  systemReducedMotion.value ? 0 : MOTION_OPTIONS.find((option) => option.id === prefs.value.motion)!.factor
)

/** Load stored prefs and start applying them; call from onMounted to keep hydration stable. */
export function initPreferences() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  prefs.value = readStored()
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  systemDark.value = dark.matches
  systemReducedMotion.value = reduced.matches
  dark.addEventListener('change', (event) => { systemDark.value = event.matches })
  reduced.addEventListener('change', (event) => { systemReducedMotion.value = event.matches })
  watch([prefs, resolvedTheme, motionFactor], () => {
    apply()
    try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs.value)) } catch { /* storage unavailable */ }
  }, { deep: true, immediate: true })
}

export function usePreferences() {
  return {
    prefs,
    resolvedTheme,
    motionFactor,
    /** Flip between day and night, leaving "system" for an explicit choice. */
    toggleTheme() {
      prefs.value.theme = resolvedTheme.value === 'dark' ? 'light' : 'dark'
    },
  }
}
