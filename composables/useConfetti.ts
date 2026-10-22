/**
 * A short burst of confetti from a point on screen, drawn on a throwaway
 * full-screen canvas. No dependencies; skipped when motion is turned off.
 */

const COLORS = ['#4f7cff', '#2fae74', '#f5b942', '#ff6b8b', '#8b6cf0', '#3cc7e0']
const DURATION_MS = 1600
const GRAVITY = 0.32
const DRAG = 0.985

interface Piece {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rotation: number
  spin: number
  color: string
  shape: 'rect' | 'circle'
}

/** `motion` is the app's transition-speed factor (0 = reduced motion). `accent` adds the board colour. */
export function fireConfetti(x: number, y: number, options: { motion?: number; accent?: string } = {}) {
  if (typeof window === 'undefined' || options.motion === 0) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const canvas = document.createElement('canvas')
  canvas.className = 'confetti-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.width = window.innerWidth * dpr
  canvas.height = window.innerHeight * dpr
  document.body.append(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) { canvas.remove(); return }
  ctx.scale(dpr, dpr)

  const colors = options.accent ? [options.accent, ...COLORS] : COLORS
  const pieces: Piece[] = Array.from({ length: 90 }, () => {
    // Mostly upward, fanned out ±60°.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI / 1.5)
    const speed = 7 + Math.random() * 9
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.4,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      shape: Math.random() < 0.25 ? 'circle' : 'rect',
    }
  })

  const start = performance.now()
  let last = start
  const frame = (now: number) => {
    const elapsed = now - start
    // Normalise to 60fps steps so fast displays don't speed it up.
    const step = Math.min((now - last) / 16.67, 3)
    last = now
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    const fade = elapsed > DURATION_MS * 0.65 ? 1 - (elapsed - DURATION_MS * 0.65) / (DURATION_MS * 0.35) : 1
    ctx.globalAlpha = Math.max(fade, 0)
    for (const p of pieces) {
      p.vx *= DRAG ** step
      p.vy = p.vy * DRAG ** step + GRAVITY * step
      p.x += p.vx * step
      p.y += p.vy * step
      p.rotation += p.spin * step
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rotation)
      ctx.fillStyle = p.color
      if (p.shape === 'circle') {
        ctx.beginPath()
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // Squash with rotation so strips appear to flutter.
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.rotation * 2)) + 1)
      }
      ctx.restore()
    }
    if (elapsed < DURATION_MS) requestAnimationFrame(frame)
    else canvas.remove()
  }
  requestAnimationFrame(frame)
}
