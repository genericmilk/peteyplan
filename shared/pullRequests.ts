/**
 * Pull request links attached to a card. Stored as plain URLs; the label and
 * provider are derived so any host works, with short labels for the common ones.
 */

export const PULL_REQUESTS_MAX = 10

export type PrProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'other'

export interface PullRequestLink {
  url: string
  provider: PrProvider
  /** Short label, e.g. `owner/repo#123` */
  label: string
  /** PR number when the URL has one */
  number: number | null
}

/** Parse a PR URL into a display label. Returns null for anything that isn't an http(s) URL. */
export function parsePullRequest(input: string): PullRequestLink | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const href = url.href
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const host = url.hostname.replace(/^www\./, '')

  const github = parts.length >= 4 && parts[2] === 'pull' && /^\d+$/.test(parts[3]!)
  if (github) {
    return { url: href, provider: host === 'github.com' ? 'github' : 'other', label: `${parts[0]}/${parts[1]}#${parts[3]}`, number: Number(parts[3]) }
  }
  // gitlab.com/group/sub/repo/-/merge_requests/12
  const mr = parts.indexOf('merge_requests')
  if (mr > 1 && parts[mr - 1] === '-' && /^\d+$/.test(parts[mr + 1] ?? '')) {
    return { url: href, provider: 'gitlab', label: `${parts.slice(0, mr - 1).join('/')}!${parts[mr + 1]}`, number: Number(parts[mr + 1]) }
  }
  // bitbucket.org/workspace/repo/pull-requests/7
  if (parts.length >= 4 && parts[2] === 'pull-requests' && /^\d+$/.test(parts[3]!)) {
    return { url: href, provider: 'bitbucket', label: `${parts[0]}/${parts[1]}#${parts[3]}`, number: Number(parts[3]) }
  }
  // dev.azure.com/org/project/_git/repo/pullrequest/42
  const azure = parts.indexOf('pullrequest')
  if (azure > 1 && parts[azure - 2] === '_git' && /^\d+$/.test(parts[azure + 1] ?? '')) {
    return { url: href, provider: 'azure', label: `${parts[azure - 1]}!${parts[azure + 1]}`, number: Number(parts[azure + 1]) }
  }
  const tail = parts.at(-1)
  return { url: href, provider: 'other', label: tail ? `${host}/…/${tail}` : host, number: null }
}

/** Untrusted input (array or JSON text) → unique http(s) PR URLs, capped. */
export function normalizePullRequests(input: unknown): string[] {
  let list = input
  if (typeof input === 'string') {
    try { list = JSON.parse(input) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const url = typeof item === 'string' ? item : typeof item?.url === 'string' ? item.url : ''
    const pr = url && url.length <= 500 ? parsePullRequest(url) : null
    if (pr && !out.includes(pr.url)) out.push(pr.url)
    if (out.length >= PULL_REQUESTS_MAX) break
  }
  return out
}
