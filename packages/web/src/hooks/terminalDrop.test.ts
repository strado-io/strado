import { describe, expect, it, vi } from 'vitest';
import { attachDroppedImages } from './terminalDrop';

function imageFile(name: string, content: string, type = 'image/png'): File {
  return new File([content], name, { type });
}

describe('attachDroppedImages', () => {
  it('uploads each image and sends its returned path', async () => {
    const upload = vi.fn(async (_name: string, _b64: string) => ({ path: `/wt/.strado-uploads/${_name}` }));
    const sendPath = vi.fn();
    await attachDroppedImages([imageFile('a.png', 'hello')], { upload, sendPath });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toBe('a.png');
    expect(upload.mock.calls[0]![1]).toBe(btoa('hello')); // base64 of content
    expect(sendPath).toHaveBeenCalledWith('/wt/.strado-uploads/a.png');
  });

  it('ignores non-image files', async () => {
    const upload = vi.fn(async () => ({ path: '/x' }));
    const sendPath = vi.fn();
    await attachDroppedImages([imageFile('a.txt', 'hi', 'text/plain')], { upload, sendPath });
    expect(upload).not.toHaveBeenCalled();
    expect(sendPath).not.toHaveBeenCalled();
  });

  it('skips images larger than maxBytes', async () => {
    const upload = vi.fn(async () => ({ path: '/x' }));
    const sendPath = vi.fn();
    await attachDroppedImages([imageFile('big.png', 'abcdef')], { upload, sendPath, maxBytes: 3 });
    expect(upload).not.toHaveBeenCalled();
  });
});
