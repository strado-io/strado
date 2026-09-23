export type Path = (string | number)[];

export type SurfaceKind =
  | 'mcp-list' | 'skill-list' | 'plugin-list' | 'hook-list'
  | 'permissions' | 'kv' | 'enum' | 'toggle' | 'markdown' | 'raw';

export type Format = 'json' | 'jsonc' | 'text' | 'dir';

export type ScopeTarget = { file: string; path: Path; format: Format };

export type Surface = {
  id: string;
  label: string;
  group: string;
  kind: SurfaceKind;
  readOnly?: boolean;
  options?: string[];        // for kind 'enum'
  global?: ScopeTarget;
  project?: ScopeTarget;
};

export type AgentDescriptor = {
  id: string;
  label: string;
  toolCheckId: string;
  surfaces: Surface[];
};

export type Scope = 'global' | 'project';

export type SurfaceValue = {
  id: string;
  label: string;
  group: string;
  kind: SurfaceKind;
  readOnly: boolean;
  options?: string[];
  value: unknown;
  inheritedValue?: unknown;
  // Set when the *global* file's read for this surface failed (project
  // scope only) — distinct from `error`, which reports a failure on this
  // scope's own file. A project surface can be legitimately `unset` while
  // its global counterpart is unparseable; without this field that failure
  // is invisible, because `inheritedValue` alone can't distinguish "global
  // has no value" from "global read failed".
  inheritedError?: string;
  source: 'set' | 'inherited' | 'unset';
  file: string;
  exists: boolean;
  error?: string;
};

export interface FormatDriver {
  get(text: string, path: Path): unknown;
  set(text: string, path: Path, value: unknown): string;
  remove(text: string, path: Path): string;
}

// The wire shape of one entry in `GET /api/agent-config/agents` (see
// routes/agentConfig.ts). Named and exported — rather than left as an
// object literal inline in the route — specifically so the web package's
// hand-mirrored copy in packages/web/src/api.ts can be checked against this
// one by a compile-time structural-equality test
// (packages/web/src/agentConfigTypesParity.test.ts), instead of the two
// silently drifting apart the next time a field is added here.
export type AgentSummary = { id: string; label: string; installed: boolean; supported: boolean; files: string[] };
