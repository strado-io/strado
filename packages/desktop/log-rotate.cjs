'use strict';
const fs = require('node:fs');

// The server log is opened in append mode and never truncated, so a long-lived
// install grows it without bound (one workstation reached 180 MB). Keep the
// live file plus one previous generation — enough to debug a "did not come up"
// report, bounded enough to ignore.
const MAX_LOG_BYTES = 32 * 1024 * 1024;

/**
 * Move `file` aside if it has grown past the cap, replacing any earlier
 * rotation. Returns whether a rotation happened. Never throws: a log that
 * cannot be rotated must not stop the app from starting.
 */
function rotateIfOversized(file, maxBytes = MAX_LOG_BYTES) {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // no log yet, or a permission problem — carry on either way
  }
}

module.exports = { rotateIfOversized, MAX_LOG_BYTES };
