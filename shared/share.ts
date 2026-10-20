/**
 * Share links: a card packed into a URL fragment so it can be pasted into
 * another PeteyPlan instance. The data never touches a server; the
 * recipient's own app decodes it and offers to add it to a board.
 */

import { normalizeChecklist } from './checklist'

export const SHARE_HASH_KEY = 'card'

export interface SharedCard {
  title: string
  description: string
  jiraKey: string
  dueBy: string
  kind: string
  /** Labels let the recipient match their own work types when ids differ */
  kindLabel: string
  progress: string
  progressLabel: string
  checklist: { text: string; done: boolean }[]
  /** Sender's ref, e.g. `PP-12`, shown for context only */
  ref: string
}

/** Compact wire shape (version 1); short keys keep the link small. */
interface WireV1 {
  v: 1
  t: string
  d?: string
  j?: string
  u?: string
  k?: string
  kl?: string
  p?: string
  pl?: string
  c?: [string, 0 | 1][]
  r?: string
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export async function encodeSharedCard(card: SharedCard): Promise<string> {
  const wire: WireV1 = { v: 1, t: card.title }
  if (card.description) wire.d = card.description
  if (card.jiraKey) wire.j = card.jiraKey
  if (card.dueBy) wire.u = card.dueBy
  if (card.kind) wire.k = card.kind
  if (card.kindLabel) wire.kl = card.kindLabel
  if (card.progress) wire.p = card.progress
  if (card.progressLabel) wire.pl = card.progressLabel
  if (card.checklist.length) wire.c = card.checklist.map((item) => [item.text, item.done ? 1 : 0])
  if (card.ref) wire.r = card.ref
  const json = new TextEncoder().encode(JSON.stringify(wire))
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))
}

/** Decode a share token; returns null for anything malformed or unknown. */
export async function decodeSharedCard(token: string): Promise<SharedCard | null> {
  try {
    const json = new TextDecoder().decode(await pipe(fromBase64Url(token), new DecompressionStream('deflate-raw')))
    const wire = JSON.parse(json) as Partial<WireV1>
    if (!wire || wire.v !== 1) return null
    const title = str(wire.t, 120).trim()
    if (!title) return null
    const checklist = normalizeChecklist(
      Array.isArray(wire.c) ? wire.c.map((entry) => Array.isArray(entry) ? { text: entry[0], done: entry[1] === 1 } : null) : []
    ).map(({ text, done }) => ({ text, done }))
    return {
      title,
      description: str(wire.d, 20000),
      jiraKey: str(wire.j, 200),
      dueBy: /^\d{4}-\d{2}-\d{2}$/.test(str(wire.u, 10)) ? str(wire.u, 10) : '',
      kind: str(wire.k, 40),
      kindLabel: str(wire.kl, 40),
      progress: str(wire.p, 40),
      progressLabel: str(wire.pl, 40),
      checklist,
      ref: str(wire.r, 20),
    }
  } catch {
    return null
  }
}

/** Pull a share token out of a URL fragment such as `#card=…`. */
export function shareTokenFrom(hash: string): string | null {
  return hash.match(new RegExp(`(?:^|[#&])${SHARE_HASH_KEY}=([A-Za-z0-9_-]+)`))?.[1] ?? null
}
