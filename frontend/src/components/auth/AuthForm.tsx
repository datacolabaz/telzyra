"use client";

import { useState, type FormEvent } from "react";
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

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError && (
        <p role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {message(formError)}
        </p>
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
