// jarvis_* tools: what a Focus Jarvis turn may do, and nothing else. The
// server describes them (GET /api/jarvis-tools, built from its action list)
// and runs them (POST /api/jarvis-tools/:tool), deciding there which wait for
// the person's approval. Identity is the turn's token (STRADO_JARVIS_TOKEN,
// handed over in a 0600 mcp.json), sent in its own header, never a tab's.
import { requestJson, serverFromEnv } from '../lib/transport.mjs';
import { text } from './rpc.mjs';

export const JARVIS_TOKEN_ENV = 'STRADO_JARVIS_TOKEN';
const HEADER = 'x-strado-jarvis-token';
const LIST_TIMEOUT_MS = 5000;
// Over the server's own wait for a window (60 s) to open an agent.
const CALL_TIMEOUT_MS = 90000;

/** The turn's tools, as the server lists them; none when there is no token or no server. */
export async function jarvisTools(env = process.env, request = requestJson) {
  const token = env[JARVIS_TOKEN_ENV];
  const server = serverFromEnv(env);
  if (!token || !server) return [];
  const headers = { [HEADER]: token };
  let res;
  try {
    res = await request({ ...server, method: 'GET', urlPath: '/api/jarvis-tools', headers, timeoutMs: LIST_TIMEOUT_MS });
  } catch {
    return [];
  }
  if (res.status !== 200 || !Array.isArray(res.json)) return [];
  return res.json
    .filter((s) => s && typeof s.name === 'string' && s.name.startsWith('jarvis_') && s.inputSchema && typeof s.inputSchema === 'object')
    .map((s) => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      inputSchema: s.inputSchema,
      run: async (args) => {
        const r = await request({
          ...server, method: 'POST', urlPath: `/api/jarvis-tools/${encodeURIComponent(s.name)}`, headers,
          body: JSON.stringify(args ?? {}), timeoutMs: CALL_TIMEOUT_MS,
        });
        if (r.status >= 200 && r.status < 300 && r.json && typeof r.json.text === 'string') return text(r.json.text);
        const msg = r.json && r.json.error && typeof r.json.error.message === 'string' ? r.json.error.message : `HTTP ${r.status}`;
        throw new Error(msg);
      },
    }));
}

/** What `strado` serves: a Focus Jarvis turn (its token is set) gets ONLY the
 *  jarvis_* tools, never a tab's preview, intercom or app-control tools. */
export async function toolsFor(env, tabTools, request = requestJson) {
  return env[JARVIS_TOKEN_ENV] ? jarvisTools(env, request) : tabTools(env);
}
