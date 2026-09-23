import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Native PTYs and detached daemons own process-level handles. Isolate
    // suites in processes so a recycled worker thread cannot strand them.
    pool: 'forks',
    testTimeout: 15_000,
    // Empty, not absent: the app exports STRADO_LICENSE_REQUIRED=1 into every
    // terminal it spawns, so a suite run from inside Strado hit the license
    // gate and 401'd its way through every route test. Tests must not depend on
    // whose shell they were started from.
    // STRADO_SESSION_ID is the same story: the hook scripts read it, so a suite
    // run from inside a Strado terminal saw that terminal's session id in
    // payloads the test never sent.
    env: {
      STRADO_INPROC_PTY: '1',
      // No suite should reach the LiteLLM price catalog; tests inject rates.
      STRADO_PRICE_CATALOG: 'off',
      STRADO_HOME: '',
      STRADO_LICENSE_REQUIRED: '',
      STRADO_SESSION_ID: '',
      STRADO_CLAUDE_JSON: path.join(os.tmpdir(), `strado-vitest-${process.pid}-claude.json`),
    },
  },
});
