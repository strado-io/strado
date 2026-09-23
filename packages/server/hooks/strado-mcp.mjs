#!/usr/bin/env node
// `strado` — the one MCP server for every Strado tool family. Spawned by the
// agent harness with the TAB's environment, which is the whole scoping model:
// STRADO_WORKTREE / STRADO_SERVER for the preview tools, STRADO_AGENT_TOKEN and
// STRADO_SERVER_SOCKET | STRADO_STATUS_PORT for the intercom tools.
import { serve } from './mcp/rpc.mjs';
import { previewTools } from './mcp/preview.mjs';
import { intercomTools } from './mcp/intercom.mjs';

export const VERSION = '0.4.0';

export function allTools(env = process.env) {
  return [...previewTools(env), ...intercomTools(env)];
}

// No top-level await: the packagers bundle this file to CommonJS, which esbuild
// refuses for top-level await. serve() resolves once stdin ends; exit promptly
// instead of relying on the event loop to drain on its own.
void serve({ name: 'strado', version: VERSION, tools: allTools() }).then(() => process.exit(0));
