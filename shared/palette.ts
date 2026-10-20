/** Command palette matching: every query word must appear; title hits rank above keyword hits. */

export interface PaletteEntry {
  id: string
  group: string
  title: string
  /** Extra searchable text (description, column, board, ref…) not shown as the title */
  keywords?: string
  /** Fixed tie-breaker within a group; lower shows first */
  order?: number
  /** Only listed once the user types something */
  queryOnly?: boolean
  /** Matches any non-empty query with the lowest score (e.g. "Filter for …") */
  anyQuery?: boolean
}

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Score one entry against the query; null when it doesn't match. */
export function scoreEntry(entry: PaletteEntry, query: string): number | null {
  const terms = words(query)
  if (!terms.length) return entry.queryOnly || entry.anyQuery ? null : 0
  if (entry.anyQuery) return 0
  const title = entry.title.toLowerCase()
  const titleWords = words(title)
  const rest = (entry.keywords ?? '').toLowerCase()
  const restWords = words(rest)
  let score = 0
  for (const term of terms) {
    if (title === term) score += 100
    else if (title.startsWith(term)) score += 60
    else if (titleWords.some((word) => word.startsWith(term))) score += 40
    else if (term.length >= 3 && title.includes(term)) score += 25
    else if (restWords.some((word) => word === term)) score += 20
    else if (restWords.some((word) => word.startsWith(term))) score += 12
    // Mid-word hits only for longer terms, so "do" doesn't match "restore".
    else if (term.length >= 3 && rest.includes(term)) score += 4
    else return null
  }
  return score
}

/**
 * Rank entries for a query and cap each group so a flood of cards can't bury
 * actions. With no query, groups keep the order first seen in `entries`;
 * while typing, the group holding the best match comes first.
 */
export function rankEntries<T extends PaletteEntry>(entries: T[], query: string, perGroup = 8): T[] {
  const groups = new Map<string, { entry: T; score: number; index: number }[]>()
  entries.forEach((entry, index) => {
    if (!groups.has(entry.group)) groups.set(entry.group, [])
    const score = scoreEntry(entry, query)
    if (score !== null) groups.get(entry.group)!.push({ entry, score, index })
  })
  const sorted = [...groups.values()]
    .filter((hits) => hits.length)
    .map((hits) => hits.sort((a, b) => b.score - a.score || (a.entry.order ?? 0) - (b.entry.order ?? 0) || a.index - b.index))
  sorted.sort((a, b) => b[0].score - a[0].score) // stable: ties keep entry order
  return sorted.flatMap((hits) => hits.slice(0, perGroup).map((hit) => hit.entry))
}
