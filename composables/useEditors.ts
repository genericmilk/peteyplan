import { computed } from 'vue'
import { usePreferences, type CodeEditor } from '~/composables/usePreferences'

/**
 * Code editors open files through their URL scheme (vscode://file/…), so the
 * browser hands the file to the app on this computer and the server never runs
 * a command. `{path}` in a template becomes the file's absolute path.
 */

export const EDITOR_PRESETS: CodeEditor[] = [
  { id: 'vscode', name: 'VS Code', url: 'vscode://file{path}' },
  { id: 'cursor', name: 'Cursor', url: 'cursor://file{path}' },
  { id: 'windsurf', name: 'Windsurf', url: 'windsurf://file{path}' },
  { id: 'zed', name: 'Zed', url: 'zed://file{path}' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', url: 'vscode-insiders://file{path}' },
  { id: 'phpstorm', name: 'PhpStorm', url: 'phpstorm://open?file={path}' },
  { id: 'webstorm', name: 'WebStorm', url: 'webstorm://open?file={path}' },
  { id: 'idea', name: 'IntelliJ IDEA', url: 'idea://open?file={path}' },
  { id: 'textmate', name: 'TextMate', url: 'txmt://open?url=file://{path}' },
]

/** Join a repo folder and a repo-relative file (or '' for the folder itself) into `/abs/path`, with forward slashes even on Windows. */
export function joinRepoPath(root: string, file: string): string {
  const base = root.replace(/[\\/]+$/, '')
  const joined = (file ? `${base}/${file}` : base).replace(/\\/g, '/')
  return joined.startsWith('/') ? joined : `/${joined}`
}

/** Fill a template; each path segment is encoded so spaces and # survive, keeping `C:` readable. */
export function editorUrl(template: string, absPath: string): string {
  const encoded = absPath.split('/').map((part) => encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, '$1:')).join('/')
  return template.split('{path}').join(encoded)
}

/** Templates that would run script or load data in this page are refused. */
export function editorUrlProblem(template: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(template.trim())?.[1]?.toLowerCase()
  if (!scheme) return 'Start with the editor\'s scheme, like vscode://'
  if (['javascript', 'data', 'vbscript', 'blob'].includes(scheme)) return `${scheme}: links aren't allowed`
  if (!template.includes('{path}')) return 'Include {path} where the file goes'
  return ''
}

export function useEditors() {
  const { prefs } = usePreferences()
  const editors = computed(() => prefs.value.editors.filter((editor) => !editorUrlProblem(editor.url)))
  const defaultEditor = computed(() =>
    editors.value.find((editor) => editor.id === prefs.value.defaultEditor) ?? editors.value[0] ?? null
  )

  function openInEditor(editor: CodeEditor, absPath: string) {
    if (editorUrlProblem(editor.url)) return
    const url = editorUrl(editor.url, absPath)
    // A web editor gets its own tab; an app scheme just hands off without leaving the page.
    if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener')
    else window.location.assign(url)
  }

  return { editors, defaultEditor, openInEditor }
}
