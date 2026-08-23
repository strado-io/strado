import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';

export type LockfileComparison = {
  equal: boolean;
  sourceHash: string | null;
  targetHash: string | null;
};

export async function compareLockfiles(
  sourcePath: string,
  targetPath: string,
): Promise<LockfileComparison> {
  const [sourceHash, targetHash] = await Promise.all([hashIfExists(sourcePath), hashIfExists(targetPath)]);
  return {
    equal: sourceHash === targetHash,
    sourceHash,
    targetHash,
  };
}

async function hashIfExists(filePath: string): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
