// "Open in editor": hand a worktree (or one file at a line) to the person's
// own desktop editor. It replaces the embedded VS Code (removed), so Strado
// never runs an editor itself. It only launches the app the person chose.
//
// Rules:
// - Editors come only from EDITORS below; argv is built here, never taken from a request.
// - The path must be inside a worktree this server owns (same checks as Files),
//   and the file must exist. Line/col are 1-based and optional.
// - This machine only: POSTs are behind assertLocalHub, and a runner worktree
//   has no local editor, so the web hides the button for remote worktrees.

export type EditorId =
  | 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf' | 'antigravity' | 'zed' | 'sublime'
  | 'webstorm' | 'idea' | 'pycharm' | 'goland' | 'xcode' | 'system';

export type EditorSpec = {
  id: EditorId;
  label: string;
  /** CLI looked up on PATH and the common bin dirs (same detection as language servers). */
  cli?: string;
  /** macOS app bundle name, used with `open -a` when the CLI isn't installed. */
  macApp?: string;
  /** How a file at a line is passed to the CLI. */
  goto: 'vscode' | 'zed' | 'sublime' | 'jetbrains' | 'xcode' | 'none';
};

// vscode-style: `code -g file:line:col`. zed/sublime: `file:line:col`.
// jetbrains: `--line N file`. xcode: `xed -l N file`. system: the OS default
// app for the folder or file (macOS `open`, Linux `xdg-open`), with no line.
export const EDITORS: EditorSpec[] = [
  { id: 'vscode', label: 'VS Code', cli: 'code', macApp: 'Visual Studio Code', goto: 'vscode' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', cli: 'code-insiders', macApp: 'Visual Studio Code - Insiders', goto: 'vscode' },
  { id: 'cursor', label: 'Cursor', cli: 'cursor', macApp: 'Cursor', goto: 'vscode' },
  { id: 'windsurf', label: 'Windsurf', cli: 'windsurf', macApp: 'Windsurf', goto: 'vscode' },
  { id: 'antigravity', label: 'Antigravity', cli: 'antigravity', macApp: 'Antigravity', goto: 'vscode' },
  { id: 'zed', label: 'Zed', cli: 'zed', macApp: 'Zed', goto: 'zed' },
  { id: 'sublime', label: 'Sublime Text', cli: 'subl', macApp: 'Sublime Text', goto: 'sublime' },
  { id: 'webstorm', label: 'WebStorm', cli: 'webstorm', macApp: 'WebStorm', goto: 'jetbrains' },
  { id: 'idea', label: 'IntelliJ IDEA', cli: 'idea', macApp: 'IntelliJ IDEA', goto: 'jetbrains' },
  { id: 'pycharm', label: 'PyCharm', cli: 'pycharm', macApp: 'PyCharm', goto: 'jetbrains' },
  { id: 'goland', label: 'GoLand', cli: 'goland', macApp: 'GoLand', goto: 'jetbrains' },
  { id: 'xcode', label: 'Xcode', cli: 'xed', macApp: 'Xcode', goto: 'xcode' },
  { id: 'system', label: 'Default app', goto: 'none' },
];

export type EditorStatus = {
  id: EditorId;
  label: string;
  /** Found as a CLI or (macOS) as an installed app. 'system' is always available. */
  available: boolean;
  /** Can open at a line (CLI found and goto != 'none'). */
  lines: boolean;
};

export type EditorsAnswer = {
  editors: EditorStatus[];
  /** The person's choice (Settings › Files › Open files in); null = first available, then 'system'. */
  preferred: EditorId | null;
};

export type OpenInEditorBody = {
  worktreePath: string;
  /** Relative to the worktree; omitted = open the worktree folder. */
  path?: string;
  line?: number;
  col?: number;
  /** Omitted = the preferred editor. */
  editor?: EditorId;
};

export const EDITOR_ROUTES = {
  list: '/api/editors', // GET → EditorsAnswer
  icon: '/api/editors/:id/icon', // GET → image/png of the app's own icon (macOS); 404 when none
  setPreferred: '/api/editors/preferred', // POST { editor: EditorId | null } → 204   (assertLocalHub)
  open: '/api/w/:ws/open-in-editor', // POST OpenInEditorBody → 204   (assertLocalHub)
} as const;
