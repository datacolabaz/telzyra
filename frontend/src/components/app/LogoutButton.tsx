"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";

/** Ends the session at the API (CSRF-protected), then returns to the login page. */
export function LogoutButton({ apiUrl, csrfToken, redirectTo, label }: { apiUrl: string; csrfToken: string; redirectTo: string; label: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className={buttonClass("secondary")}
      onClick={async () => {
        setPending(true);
        try {
          await fetch(`${apiUrl}/v1/auth/logout`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrfToken } });
        } finally {
          window.location.assign(redirectTo);
        }
      }}
    >
      <LogOut className="size-4" aria-hidden />
      {label}
    </button>
  );
}
