#!/usr/bin/env node
import http from 'node:http';

const socketPath = process.env.STRADO_SERVER_SOCKET;
const brokerToken = process.env.STRADO_GIT_BROKER_TOKEN;
if (!socketPath || !brokerToken) process.exit(1);

const body = JSON.stringify({ brokerToken });
const request = http.request({
  socketPath,
  path: '/api/git/credential',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  timeout: 10_000,
}, (response) => {
  let raw = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { raw += chunk; });
  response.on('end', () => {
    if (response.statusCode !== 200) process.exit(1);
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.token !== 'string' || !parsed.token) process.exit(1);
      process.stdout.write(`${parsed.token}\n`);
    } catch {
      process.exit(1);
    }
  });
});
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
request.end(body);
