// The server's Focus Jarvis approvals use a copy of destructiveCommand (this
// package never imports server runtime code; a test may). Both must flag the
// same lines with the same reason.
import { describe, expect, it } from 'vitest';
import { destructiveCommand as server } from '../../../../server/src/services/jarvisChat/safety';
import { destructiveCommand as web } from './safety';

const CORPUS = [
  'ls -la', 'npm run dev', 'rm -rf dist', 'rm -r -f build', 'sudo rm -fr /', 'rm file.txt', 'cd x && rm -rf y',
  'git push --force', 'git push -f origin main', 'git push origin +main', 'git push', 'git reset --hard HEAD~1', 'git reset HEAD',
  'git clean -fd', 'git branch -D old', 'git branch --delete --force old', 'git checkout -- .', 'git restore .',
  'psql -c "DROP TABLE users"', 'kill -9 123', 'pkill node', 'mkfs.ext4 /dev/sda1', 'dd if=x of=/dev/sda', 'chmod -R 777 .',
  'chown --recursive me .', 'truncate -s 0 log', 'docker system prune -a', 'kubectl delete pod x', 'cat x > /dev/sda',
  'env FOO=1 nice rm -rf tmp', 'echo hello | grep h', 'git status; git log',
];

describe('destructiveCommand parity (server copy vs the box)', () => {
  it.each(CORPUS)('%s', (line) => {
    expect(server(line)).toBe(web(line));
  });
});
