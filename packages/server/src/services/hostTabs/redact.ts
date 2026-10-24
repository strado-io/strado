// Redaction for the runner's own log before any line leaves the runner.
// Belt and braces: the runner is not supposed to log secrets at all. Shapes,
// not exact formats — a false positive costs a word of log, a miss costs a
// credential.

const R = '[redacted]';

/** Credentials recognizable by their own shape. */
const SHAPED: RegExp[] = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g, // Anthropic, OpenAI, OpenRouter
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab PATs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

/** A whole PEM private key inside one message. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** An Authorization scheme followed by its credential. */
const SCHEME = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/** https://user:password@host */
const USERINFO = /(:\/\/[^\s/:@]+:)[^\s/@]+@/g;

/** A query parameter whose name says it is a secret, at any length: a relay
 *  ticket or an OAuth code is short and still a credential. */
const QUERY = /([?&](?:ticket|token|access_token|code|key|sig|signature|secret|session|cookie|credential)=)[^&\s"']+/gi;

/** A device-login user code (EMNE-7R5NE) after the word "code". */
const DEVICE_CODE = /(\b[Cc]ode\b[^\n]{0,40}?)\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;

/** A long value after a field whose name says it is a secret:
 *  token=…, "api_key": "…", secret: …, password=…, cookie: …
 *  Stops at `&` and never starts on `[`, so it does not swallow a query
 *  string or text an earlier rule already redacted. */
const LABELED =
  /\b([A-Za-z_-]*(?:token|key|secret|password|authorization|ticket|cookie|session|credential|code)[A-Za-z_-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&[]{16,})/gi;

export function redact(text: string): string {
  let out = text.replace(PEM, R);
  for (const re of SHAPED) out = out.replace(re, R);
  out = out.replace(SCHEME, R);
  out = out.replace(USERINFO, `$1${R}@`);
  out = out.replace(QUERY, `$1${R}`);
  out = out.replace(DEVICE_CODE, `$1${R}`);
  out = out.replace(LABELED, (_m, label: string, sep: string) => `${label}${sep}${R}`);
  return out;
}

/** For a log read line by line: a PEM block split across lines is redacted
 *  from its BEGIN line through its END line. */
export function lineRedactor(): (line: string) => string {
  let inKey = false;
  return (line) => {
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false;
      return R;
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) {
      inKey = true;
      return R;
    }
    return redact(line);
  };
}
