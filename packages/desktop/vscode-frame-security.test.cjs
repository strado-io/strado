const test = require('node:test');
const assert = require('node:assert/strict');

const {
  vscodeOrigin,
  stripVsCodeFrameHeaders,
  headersForRequest,
} = require('./vscode-frame-security.cjs');

test('accepts only explicit loopback HTTP origins', () => {
  assert.equal(vscodeOrigin('http://127.0.0.1:58769/'), 'http://127.0.0.1:58769');
  assert.equal(vscodeOrigin('http://127.0.0.1:58769/?folder=%2Ftmp'), 'http://127.0.0.1:58769');
  assert.equal(vscodeOrigin('http://localhost:58769/'), null);
  assert.equal(vscodeOrigin('https://127.0.0.1:58769/'), null);
  assert.equal(vscodeOrigin('http://127.0.0.1/'), null);
  assert.equal(vscodeOrigin('not a url'), null);
});

test('removes only frame-blocking headers and directives', () => {
  assert.deepEqual(stripVsCodeFrameHeaders({
    'Content-Type': ['text/html'],
    'Content-Security-Policy': [
      "default-src 'self'; script-src 'self'; frame-ancestors 'self'",
      "frame-ancestors 'none'",
    ],
    'X-Frame-Options': ['SAMEORIGIN'],
    'X-Other': ['kept'],
  }), {
    'Content-Type': ['text/html'],
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'"],
    'X-Other': ['kept'],
  });
});

test('relaxes subframes only for the registered webContents and origin', () => {
  const original = {
    'Content-Security-Policy': ["default-src 'self'", "frame-ancestors 'self'"],
    'x-frame-options': ['SAMEORIGIN'],
  };
  const allowed = new Map([[41, new Set(['http://127.0.0.1:58769'])]]);

  assert.deepEqual(headersForRequest({
    resourceType: 'subFrame',
    webContentsId: 41,
    url: 'http://127.0.0.1:58769/?folder=%2Ftmp',
    responseHeaders: original,
  }, allowed), {
    'Content-Security-Policy': ["default-src 'self'"],
  });

  assert.equal(headersForRequest({
    resourceType: 'subFrame',
    webContentsId: 42,
    url: 'http://127.0.0.1:58769/',
    responseHeaders: original,
  }, allowed), original);
  assert.equal(headersForRequest({
    resourceType: 'mainFrame',
    webContentsId: 41,
    url: 'http://127.0.0.1:58769/',
    responseHeaders: original,
  }, allowed), original);
  assert.equal(headersForRequest({
    resourceType: 'subFrame',
    webContentsId: 41,
    url: 'http://127.0.0.1:60000/',
    responseHeaders: original,
  }, allowed), original);
});
