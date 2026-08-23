// The one collapse indicator: points right when closed, rotates down when
// open. Unicode triangles render at inconsistent sizes across fonts — this
// keeps every disclosure the same weight as the rest of the iconography.
export function Chevron({
  open,
  size = 14,
  className = '',
}: {
  open: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
