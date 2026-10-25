// Settings › Files › Language servers: the machine's language servers (mirrors
// LSP_ADMIN_ROUTES and LspServerStatus in server/src/services/lsp/types.ts).
import { ApiClientError } from '../api';

export type LspServerId =
  | 'typescript' | 'pyright' | 'gopls' | 'rust-analyzer' | 'clangd'
  | 'jdtls' | 'solargraph' | 'lua' | 'zls' | 'omnisharp' | 'texlab';

export type LspInstallOption = { command: string; os?: 'darwin' | 'linux'; needs?: string; available: boolean };

export type LspServerStatus = {
  id: LspServerId;
  lang: string;
  enabled: boolean;
  installed: boolean;
  binary?: string;
  install: LspInstallOption[];
  running: { worktreePath: string; pid: number; rssBytes: number | null; startedAt: string; lastUsedAt: string }[];
};

export type LspAdminClient = {
  list(): Promise<LspServerStatus[]>;
  setEnabled(id: LspServerId, enabled: boolean): Promise<void>;
  stop(id: LspServerId): Promise<void>;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    ...(init?.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
  if (!res.ok) throw new ApiClientError(body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  return body as T;
}

const server = (id: LspServerId) => `/api/lsp/servers/${encodeURIComponent(id)}`;

export const lspAdmin: LspAdminClient = {
  list: () => call<{ servers: LspServerStatus[] }>('/api/lsp/servers').then((b) => b.servers),
  setEnabled: (id, enabled) => call<void>(`${server(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  stop: (id) => call<void>(`${server(id)}/stop`, { method: 'POST', body: '{}' }),
};
