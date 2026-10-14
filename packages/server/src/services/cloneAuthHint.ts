// Turn git's authentication failures into a sentence that names the fix.
//
// A fresh runner box has no SSH key and no tokens of its own. When the
// desktop sends it an SSH remote with nothing to authenticate with, git says
// "Permission denied (publickey)" — true, and useless to the person reading
// the create dialog. They need to know WHICH connection to make, and where.
import { AppError } from '../errors.js';
import { isGithubHost, isGitlabHost, parseRemoteUrl } from './gitProviders.js';

const AUTH_FAILURE = [
  /Permission denied \(publickey/i,
  /could not read Username/i,
  /Authentication failed/i,
  /HTTP Basic: Access denied/i,
  /Could not read from remote repository/i,
  /Host key verification failed/i,
  /remote: Repository not found/i, // GitHub's answer for a private repo you can't see
  /returned error: 403/i,
];

export function isGitAuthFailure(text: string): boolean {
  return AUTH_FAILURE.some((re) => re.test(text));
}

/**
 * A VALIDATION error with the hint, when `err` is a git auth failure for
 * `url`; otherwise null (the caller rethrows the original).
 */
export function explainCloneFailure(err: unknown, url: string): AppError | null {
  const text = [
    err instanceof Error ? err.message : String(err),
    typeof (err as { details?: { stderr?: unknown } })?.details?.stderr === 'string'
      ? (err as { details: { stderr: string } }).details.stderr
      : '',
  ].join('\n');
  if (!isGitAuthFailure(text)) return null;
  const parsed = parseRemoteUrl(url);
  const host = parsed?.host ?? 'the git host';
  const provider = parsed
    ? isGithubHost(parsed.host, new Set()) ? 'GitHub' : isGitlabHost(parsed.host, new Set()) ? 'GitLab' : null
    : null;
  const connect = provider
    ? `connect ${provider} under Settings → Integrations on your own machine (its token is sent with the request)`
    : `add a token for ${host} under Settings → Integrations on your own machine`;
  return new AppError(
    'VALIDATION',
    `this runner cannot authenticate to ${host} for ${url}: ${connect}, or install an SSH key for ${host} on the runner.`,
  );
}
