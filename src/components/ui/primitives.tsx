import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap disabled:opacity-60 disabled:pointer-events-none";
const variants: Record<Variant, string> = {
  primary: "bg-ink-950 text-white hover:bg-ink-800",
  secondary: "bg-white text-ink-900 ring-1 ring-inset ring-ink-200 hover:bg-ink-50",
  ghost: "text-ink-700 hover:text-ink-950 hover:bg-ink-50",
};
const sizes = { md: "h-9 px-4", lg: "h-11 px-5 text-[15px]" };

export function buttonClass(variant: Variant = "primary", size: keyof typeof sizes = "md") {
  return `${base} ${variants[variant]} ${sizes[size]}`;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: keyof typeof sizes }) {
  return <Link {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Section({
  id,
  children,
  className = "",
  labelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`scroll-mt-20 py-20 sm:py-28 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHeader({
  id,
  eyebrow,
  title,
  description,
  align = "left",
}: {
  id: string;
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
}) {
  const center = align === "center" ? "mx-auto text-center" : "";
  return (
    <div className={`max-w-2xl ${center}`}>
      {eyebrow && (
        <p className="mb-3 text-sm font-medium text-brand-600">{eyebrow}</p>
      )}
      <h2 id={id} className="text-3xl font-semibold tracking-[-0.025em] text-ink-950 sm:text-4xl text-balance">
        {title}
      </h2>
      {description && <p className="mt-4 text-[17px] leading-relaxed text-ink-500 text-pretty">{description}</p>}
    </div>
  );
}

type Tone = "neutral" | "brand" | "go" | "warn";
const tones: Record<Tone, string> = {
  neutral: "bg-ink-50 text-ink-700 ring-ink-200",
  brand: "bg-brand-50 text-brand-600 ring-brand-100",
  go: "bg-go-50 text-go-600 ring-go-600/15",
  warn: "bg-warn-50 text-warn-700 ring-warn-700/15",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[var(--radius-card)] border border-ink-100 bg-white p-6 shadow-[var(--shadow-card)] ${className}`}>
      {children}
    </div>
  );
}

export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-9 items-center justify-center rounded-lg bg-ink-50 text-ink-800 ring-1 ring-inset ring-ink-100">
      {children}
    </span>
  );
}
