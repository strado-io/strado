import { effectiveValue, emptyToUndefined, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// A single MCP server entry. `env` may hold API keys, so its VALUES must
// never be rendered — only a count. `url` marks a remote (SSE/HTTP) server;
// anything else with a `command` is local (stdio).
type McpServer = { url?: string; command?: string; args?: string[]; env?: Record<string, string> };
type McpServers = Record<string, McpServer>;

function normalize(value: unknown): McpServers {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as McpServers) : {};
}

export function McpList({ surface, onChange }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const servers = normalize(effectiveValue(surface, overridden));
  const entries = Object.entries(servers);

  return (
    <div className="flex flex-col gap-2">
      <InheritedBadge
        surface={surface}
        overridden={overridden}
        onOverride={activate}
        onReset={() => void onChange(undefined)}
      />
      {entries.length === 0 && <p className="text-xs text-zinc-500">No MCP servers configured.</p>}
      {entries.map(([name, server]) => {
        const transport = server?.url ? 'remote' : 'local';
        const envCount = server?.env ? Object.keys(server.env).length : 0;
        return (
          <div
            key={name}
            className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-zinc-200">{name}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{transport}</span>
              </div>
              <span className="truncate font-mono text-zinc-500">
                {transport === 'remote' ? server.url : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
              </span>
              {/* Never render env VALUES here — they may hold API keys. */}
              {envCount > 0 && (
                <span className="text-zinc-500">
                  {envCount} env var{envCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => {
                  const next = { ...servers };
                  delete next[name];
                  void onChange(emptyToUndefined(next));
                }}
                className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-800 hover:text-red-300"
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
