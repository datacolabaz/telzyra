/**
 * Telzyra mark: a "T" drawn as a workflow — an entry node branching to two outputs
 * on the crossbar, with the stem leading down to a final step.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect width="32" height="32" rx="8" fill="#0B0D2A" />
      <path d="M8.5 11h15M16 11v10.5" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="8.5" cy="11" r="2.6" fill="#0B0D2A" stroke="#FFFFFF" strokeWidth="2" />
      <circle cx="23.5" cy="11" r="2.6" fill="#0B0D2A" stroke="#FFFFFF" strokeWidth="2" />
      <circle cx="16" cy="23" r="3" fill="#34D399" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink-950">Telzyra</span>
    </span>
  );
}
