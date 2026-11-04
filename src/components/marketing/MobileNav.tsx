"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";

interface NavLink {
  href: string;
  label: string;
}

export function MobileNav({
  items,
  login,
  start,
  openLabel,
  closeLabel,
}: {
  items: NavLink[];
  login: NavLink;
  start: NavLink;
  openLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? closeLabel : openLabel}
        className="inline-flex size-9 items-center justify-center rounded-lg text-ink-800 hover:bg-ink-50"
      >
        {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
      </button>
      {open && (
        <div
          id="mobile-nav"
          className="absolute inset-x-0 top-16 border-b border-ink-100 bg-white px-5 pb-6 pt-2 shadow-[var(--shadow-float)]"
        >
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2 py-3 text-[15px] font-medium text-ink-800 hover:bg-ink-50"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Link href={login.href} onClick={() => setOpen(false)} className={buttonClass("secondary", "lg")}>
              {login.label}
            </Link>
            <Link href={start.href} onClick={() => setOpen(false)} className={buttonClass("primary", "lg")}>
              {start.label}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
