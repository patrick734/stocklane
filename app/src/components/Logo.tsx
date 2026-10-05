/** Two lanes merging into one arrow: many pools, one best route. */
export function LogoMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" className="mark-bg" />
      <path d="M14 44 C26 44 28 24 44 22" className="mark-lane mark-lane-a" />
      <path d="M14 30 C24 30 30 22 44 22" className="mark-lane mark-lane-b" />
      <path d="M38 14 L50 22 L38 30" className="mark-head" />
    </svg>
  );
}
