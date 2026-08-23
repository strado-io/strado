import os from 'node:os';
import path from 'node:path';

/**
 * Where the runner identity lives. Must follow STRADO_HOME the same way
 * packages/runner/src/paths.ts does, or the dev and stable profiles share one
 * runner identity and fight over the same relay registration.
 */
export function runnerConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const home = env.STRADO_HOME || path.join(homedir, '.strado');
  return path.join(home, 'runner.json');
}
