"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";
import { interpolate } from "@/i18n/translator";
import { localizedPath } from "@/i18n/routing";
import type { Locale } from "@/i18n/config";

export interface AuthFormLabels {
  submit: string;
  submitting: string;
  name: string;
  email: string;
  password: string;
  passwordHint: string;
  google: string;
  or: string;
}

type Field = "name" | "email" | "password";
interface FieldError {
  code: string;
  params?: Record<string, number>;
}

/**
 * Sends credentials straight from the browser to the Platform API (credentials: "include").
 * The API sets the HttpOnly session cookie for the shared domain, sees the real client IP
 * for rate limiting and audit, and checks the Origin header against CSRF.
 * Error codes from the API are shown in the page language via validation.json.
 */
export function AuthForm({
  mode,
  locale,
  plan,
  apiUrl,
  labels,
  errors,
}: {
  mode: "login" | "register";
  locale: Locale;
  plan?: string;
  apiUrl: string;
  labels: AuthFormLabels;
  /** validation.json for the current locale, keyed by error code. */
  errors: Record<string, string>;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, FieldError>>>({});
  const [google, setGoogle] = useState(false);

  // Google sign-in: shown only when the API has a Google client configured. A failed Google
  // round trip comes back as ?error=google_<code>, shown in the page language.
  useEffect(() => {
    let active = true;
    (async () => {
      const err = new URLSearchParams(window.location.search).get("error");
      if (err && /^google_[a-z_]{1,40}$/.test(err)) setFormError(err);
      if (!apiUrl) return;
      try {
        const res = await fetch(`${apiUrl}/v1/auth/providers`, { credentials: "include" });
        const p = (res.ok ? await res.json() : {}) as { google?: boolean };
        if (active) setGoogle(!!p.google);
      } catch {
        // No Google button when the API cannot be reached; password sign-in still works.
      }
    })();
    return () => {
      active = false;
    };
  }, [apiUrl]);

  const message = (e?: FieldError | string) => {
    if (!e) return undefined;
    const err = typeof e === "string" ? { code: e } : e;
    return interpolate(errors[err.code] ?? errors.unknown ?? err.code, err.params);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFormError(undefined);
    setFieldErrors({});

    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const body = mode === "register" ? { ...data, locale, plan } : { email: data.email, password: data.password };

    try {
      if (!apiUrl) throw new Error("API not configured");
      const res = await fetch(`${apiUrl}/v1/auth/${mode}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        window.location.assign(localizedPath(locale, "/dashboard"));
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as { code?: string; fields?: Partial<Record<Field, FieldError>> };
      if (payload.code === "validation" && payload.fields) setFieldErrors(payload.fields);
      else setFormError(payload.code === "rate_limited" ? "rate_limited" : (payload.code ?? "unknown"));
    } catch {
      setFormError("service.unavailable");
    }
    setPending(false);
  }

  const field = (name: Field, type: string, autoComplete: string, hint?: string) => {
    const error = message(fieldErrors[name]);
    const describedBy = [hint && `${name}-hint`, error && `${name}-error`].filter(Boolean).join(" ") || undefined;
    return (
      <div>
        <label htmlFor={name} className="block text-sm font-medium text-ink-900">
          {labels[name]}
        </label>
        <input
          id={name}
          name={name}
          type={type}
          autoComplete={autoComplete}
          required
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`mt-1.5 block h-10 w-full rounded-lg border bg-white px-3 text-sm text-ink-950 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${
            error ? "border-red-400" : "border-ink-200"
          }`}
        />
        {hint && !error && (
          <p id={`${name}-hint`} className="mt-1.5 text-xs text-ink-400">{hint}</p>
        )}
        {error && (
          <p id={`${name}-error`} className="mt-1.5 text-xs text-red-600">{error}</p>
        )}
      </div>
    );
  };

  // method="post": if the form is submitted before hydration, credentials must never end up in the URL.
  return (
    <form method="post" onSubmit={onSubmit} noValidate className="space-y-4">
      {formError && (
        <p role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {message(formError)}
        </p>
      )}

      {google && (
        <>
          <a
            href={`${apiUrl}/v1/auth/google/start?locale=${encodeURIComponent(locale)}`}
            className={`${buttonClass("secondary", "lg")} w-full gap-2`}
          >
            <GoogleMark />
            {labels.google}
          </a>
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-ink-400" aria-hidden>
            <span className="h-px flex-1 bg-ink-200" />
            {labels.or}
            <span className="h-px flex-1 bg-ink-200" />
          </div>
        </>
      )}

      {mode === "register" && field("name", "text", "name")}
      {field("email", "email", "email")}
      {field("password", "password", mode === "register" ? "new-password" : "current-password", mode === "register" ? labels.passwordHint : undefined)}

      <button type="submit" disabled={pending} className={`${buttonClass("primary", "lg")} w-full`}>
        {pending ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}

/** Google "G" mark (brand colors, per Google sign-in branding guidelines). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
