"use client";

import { useActionState } from "react";
import { AlertCircle } from "lucide-react";
import { authAction, type AuthState, type FieldError } from "@/lib/auth/actions";
import { buttonClass } from "@/components/ui/primitives";
import { interpolate } from "@/i18n/translator";
import type { Locale } from "@/i18n/config";

export interface AuthFormLabels {
  submit: string;
  submitting: string;
  name: string;
  email: string;
  password: string;
  passwordHint: string;
}

export function AuthForm({
  mode,
  locale,
  plan,
  labels,
  errors,
}: {
  mode: "login" | "register";
  locale: Locale;
  plan?: string;
  labels: AuthFormLabels;
  /** validation.json for the current locale, keyed by error code. */
  errors: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(authAction, {});
  const message = (e?: FieldError | string) => {
    if (!e) return undefined;
    const err = typeof e === "string" ? { code: e } : e;
    return interpolate(errors[err.code] ?? errors.unknown ?? err.code, err.params);
  };

  const field = (name: "name" | "email" | "password", type: string, autoComplete: string, hint?: string) => {
    const error = message(state.fieldErrors?.[name]);
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
          defaultValue={name === "password" ? undefined : state.values?.[name]}
          key={name === "password" ? undefined : `${name}-${state.values?.[name] ?? ""}`}
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
    <form action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="locale" value={locale} />
      {plan && <input type="hidden" name="plan" value={plan} />}

      {state.formError && (
        <p role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {message(state.formError)}
        </p>
      )}

      {mode === "register" && field("name", "text", "name")}
      {field("email", "email", "email")}
      {field(
        "password",
        "password",
        mode === "register" ? "new-password" : "current-password",
        mode === "register" ? labels.passwordHint : undefined,
      )}

      <button type="submit" disabled={pending} className={`${buttonClass("primary", "lg")} w-full`}>
        {pending ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}
