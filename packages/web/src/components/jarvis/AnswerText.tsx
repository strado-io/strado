import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// The model answers in markdown (**bold**, lists, `code`). Shown compact, to
// fit the command box's row; raw html stays text (react-markdown's default).
const REMARK_PLUGINS = [remarkGfm];
const COMPONENTS: Components = {
  p: ({ children }) => <p className="[&:not(:first-child)]:mt-1.5">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => <code className="rounded bg-zinc-800 px-1 py-px font-mono text-[0.85em] text-violet-200">{children}</code>,
  pre: ({ children }) => <pre className="mt-1.5 overflow-x-auto rounded bg-zinc-800/80 p-2 text-xs [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  ul: ({ children }) => <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-zinc-500">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1 list-decimal space-y-0.5 pl-4 marker:text-zinc-500">{children}</ol>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-violet-300 underline underline-offset-2 hover:text-violet-200">{children}</a>,
  h1: ({ children }) => <p className="font-semibold text-white">{children}</p>,
  h2: ({ children }) => <p className="font-semibold text-white">{children}</p>,
  h3: ({ children }) => <p className="font-semibold text-white">{children}</p>,
};

/** A model answer in the command box, its markdown rendered. */
export function AnswerText({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words" data-testid="jarvis-answer">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{text}</Markdown>
    </div>
  );
}

/** The answer without its markdown marks: what is read aloud. */
export const plainAnswer = (text: string) =>
  text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?)/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
