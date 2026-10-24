import { describe, it, expect } from 'vitest';
import { lineRedactor, redact } from './redact.js';

const R = '[redacted]';

describe('redact', () => {
  it.each([
    ['anthropic oauth token', 'token sk-ant-oat01-AbCdEf0123456789_xyz-QWERTY rest', `token ${R} rest`],
    ['anthropic api key', 'key=sk-ant-api03-AbCdEf0123456789xyzQWERTY', `key=${R}`],
    ['openai project key', 'using sk-proj-AbCdEf0123456789xyzQWERTYuiop now', `using ${R} now`],
    ['openrouter key', 'sk-or-v1-0123456789abcdef0123456789abcdef', R],
    ['github classic token', 'gh gh' + 'p_0123456789abcdefABCDEF0123456789abcd done', `gh ${R} done`],
    ['github oauth/user/server/refresh tokens', 'gh' + 'o_0123456789abcdefABCDEF0123 gh' + 'u_0123456789abcdefABCDEF0123 gh' + 's_0123456789abcdefABCDEF0123 gh' + 'r_0123456789abcdefABCDEF0123', `${R} ${R} ${R} ${R}`],
    ['github fine-grained pat', 'github' + '_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', R],
    ['gitlab pat', 'gl' + 'pat-AbCdEf0123456789xyzQ', R],
    ['bearer header', 'Authorization: Bearer abc.def-123456789012345678', `Authorization: ${R}`],
    ['json token field', '{"token":"YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="}', `{"token":"${R}"}`],
    ['secret= hex', 'secret=0123456789abcdef0123456789abcdef', `secret=${R}`],
    ['access_key: base64', 'access_key: dGhpcyBpcyBhIHZlcnkgbG9uZyBzZWNyZXQ=', `access_key: ${R}`],
    ['password', 'password="hunter2hunter2hunter2"', `password="${R}"`],
    ['short relay ticket in a query', 'GET /r/x?ticket=ab12&x=1', `GET /r/x?ticket=${R}&x=1`],
    ['oauth code and sig in a query', 'cb?code=4/0Ab&state=s&sig=xyz', `cb?code=${R}&state=s&sig=${R}`],
    ['device code after "code"', 'Enter code: EMX4-E6YIJ', `Enter code: ${R}`],
    ['device code after "one-time code (…)"', 'Enter this one-time code (expires in 15 minutes) EMNE-7R5NE', `Enter this one-time code (expires in 15 minutes) ${R}`],
    ['cookie label', 'cookie=abcdefghijklmnop0123', `cookie=${R}`],
    ['session label', 'session_id: abcdefghijklmnop0123', `session_id: ${R}`],
    ['credential label', '"credential":"abcdefghijklmnop0123"', `"credential":"${R}"`],
    ['ticket label', 'ticket=abcdefghijklmnop0123', `ticket=${R}`],
    ['url userinfo', 'clone https://x-access-token:abc123@github.com/o/r.git', `clone https://x-access-token:${R}@github.com/o/r.git`],
    ['aws access key id', 'aws AK' + 'IAIOSFODNN7EXAMPLE used', `aws ${R} used`],
    ['pem private key in one message', 'key:\n-----BEG' + 'IN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----\nafter', `key:\n${R}\nafter`],
    ['jwt', 'got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok', `got ${R} ok`],
  ])('%s', (_name, input, out) => {
    expect(redact(input)).toBe(out);
  });

  it('leaves ordinary log lines alone', () => {
    for (const line of [
      '[runner] strado 0.1.32 listening on http://127.0.0.1:7777',
      '[runner] login-sync key fingerprint ed6f-c4bc-16a8-5e11',
      'container create b5bcb3b5a6fc7048f8ede6941ddc6f161b16e0e2be148c3e27f9348a838ce161',
      'token refresh scheduled in 30s',
      'key=short',
      'Server listening at http://127.0.0.1:7777',
      'fingerprint ed6f-c4bc-16a8-5e11',
      'GET /api/runners?page=2&sort=asc',
      'https://github.com/org/repo',
      'decode ABCD-EFGHI failed',
      'session ended for e2e',
      'exit code 1',
    ]) {
      expect(redact(line)).toBe(line);
    }
  });
});

describe('lineRedactor', () => {
  it('redacts a PEM block split across lines, then carries on', () => {
    const r = lineRedactor();
    const out = [
      'before',
      '-----BEG' + 'IN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
      'after token=sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA',
    ].map(r);
    expect(out).toEqual(['before', R, R, R, `after token=${R}`]);
  });
});
