/** Base URL for browse deep links (KYC Global Atlassian). */
export const JIRA_BROWSE_BASE = 'https://kycglobal.atlassian.net/browse'

/** Matches keys like CX-1831, ENG-12, ABC123-9 */
export const JIRA_KEY_PATTERN = /[A-Z][A-Z0-9]+-\d+/

const KEY_ONLY = new RegExp(`^${JIRA_KEY_PATTERN.source}$`, 'i')
const BROWSE_URL = new RegExp(
  `https?:\\/\\/kycglobal\\.atlassian\\.net\\/browse\\/(${JIRA_KEY_PATTERN.source})`,
  'i'
)

/**
 * Accept a bare key (CX-1831) or a full browse URL and return the
 * normalized uppercase key, or '' if the input is empty/invalid.
 */
export function normalizeJiraKey(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const fromUrl = trimmed.match(BROWSE_URL)
  if (fromUrl) return fromUrl[1].toUpperCase()

  if (KEY_ONLY.test(trimmed)) return trimmed.toUpperCase()

  // Last resort: first key-shaped token in the string
  const embedded = trimmed.toUpperCase().match(new RegExp(JIRA_KEY_PATTERN.source))
  return embedded ? embedded[0] : ''
}

export function jiraBrowseUrl(key: string): string {
  return `${JIRA_BROWSE_BASE}/${key}`
}
