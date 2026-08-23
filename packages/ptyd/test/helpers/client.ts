import net from 'node:net';
import { encodeFrame, FrameDecoder, type Frame } from '../../src/protocol.js';

export interface TestClient {
  send(msg: object, payload?: Buffer): void;
  /** Resolves with the first buffered-or-future frame matching pred. */
  waitFor(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  frames(): Frame[];
  close(): void;
}

export function connect(socketPath: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const decoder = new FrameDecoder();
    const received: Frame[] = [];
    const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
    socket.on('data', (chunk) => {
      decoder.push(chunk);
      for (const frame of decoder.drain()) {
        const i = waiters.findIndex((w) => w.pred(frame));
        if (i >= 0) waiters.splice(i, 1)[0]!.resolve(frame);
        else received.push(frame);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () =>
      resolve({
        send: (msg, payload) => socket.write(encodeFrame(msg, payload)),
        waitFor: (pred, ms = 5000) =>
          new Promise((res, rej) => {
            const i = received.findIndex(pred);
            if (i >= 0) return res(received.splice(i, 1)[0]!);
            const timer = setTimeout(() => rej(new Error('waitFor timeout')), ms);
            waiters.push({ pred, resolve: (f) => { clearTimeout(timer); res(f); } });
          }),
        frames: () => received,
        close: () => socket.destroy(),
      }),
    );
  });
}
