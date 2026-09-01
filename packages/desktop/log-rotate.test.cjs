const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rotateIfOversized, MAX_LOG_BYTES } = require('./log-rotate.cjs');

function tmpLog(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rot-'));
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return { dir, file };
}

test('leaves a log below the cap untouched', () => {
  const { file } = tmpLog(1024);
  assert.equal(rotateIfOversized(file), false);
  assert.equal(fs.statSync(file).size, 1024);
  assert.equal(fs.existsSync(`${file}.1`), false);
});

test('rotates an oversized log aside and frees the live path', () => {
  const { file } = tmpLog(MAX_LOG_BYTES + 1);
  assert.equal(rotateIfOversized(file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.statSync(`${file}.1`).size, MAX_LOG_BYTES + 1);
});

test('keeps exactly one previous log', () => {
  const { file } = tmpLog(MAX_LOG_BYTES + 1);
  fs.writeFileSync(`${file}.1`, 'older');
  rotateIfOversized(file);
  assert.equal(fs.statSync(`${file}.1`).size, MAX_LOG_BYTES + 1);
  assert.equal(fs.existsSync(`${file}.2`), false);
});

test('is a no-op when there is no log yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rot-'));
  assert.equal(rotateIfOversized(path.join(dir, 'server.log')), false);
});
