async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin);
}

export async function attachDroppedImages(
  files: File[],
  opts: {
    maxBytes?: number;
    upload: (name: string, dataBase64: string) => Promise<{ path: string }>;
    sendPath: (path: string) => void;
  },
): Promise<void> {
  const max = opts.maxBytes ?? 10 * 1024 * 1024;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > max) continue;
    const dataBase64 = await fileToBase64(file);
    const { path } = await opts.upload(file.name, dataBase64);
    opts.sendPath(path);
  }
}
