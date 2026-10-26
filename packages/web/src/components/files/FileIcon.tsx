// A file's icon: a page, tinted by its language family, so a list of paths
// (search results) scans like an editor's.
const TONE: Record<string, string> = {
  ts: 'text-sky-400', tsx: 'text-sky-400', mts: 'text-sky-400', cts: 'text-sky-400',
  js: 'text-amber-300', jsx: 'text-amber-300', mjs: 'text-amber-300', cjs: 'text-amber-300',
  json: 'text-yellow-400', yml: 'text-rose-300', yaml: 'text-rose-300', toml: 'text-rose-300',
  css: 'text-pink-400', scss: 'text-pink-400', html: 'text-orange-400',
  md: 'text-zinc-400', mdx: 'text-zinc-400',
  py: 'text-emerald-400', go: 'text-cyan-400', rs: 'text-orange-300', java: 'text-red-400', kt: 'text-violet-400',
  sh: 'text-lime-400', sql: 'text-indigo-300',
};

export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const name = path.split('/').pop() ?? path;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${TONE[ext] ?? 'text-zinc-500'}`} data-ext={ext}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
