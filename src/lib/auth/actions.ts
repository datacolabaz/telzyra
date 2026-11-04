"use server";

import { redirect } from "next/navigation";
import { isActiveLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { SITE } from "@/config/site";

/**
 * Error codes are language-neutral. The UI maps each code to messages/<locale>/validation.json.
 * Fields carry { code, params } so translated messages can interpolate (e.g. {min}).
 */
export type FieldError = { code: string; params?: Record<string, number> };
export interface AuthState {
  formError?: string;
  fieldErrors?: Partial<Record<"name" | "email" | "password", FieldError>>;
  /** Echoed back so the form keeps what the user typed (never the password). */
  values?: { name?: string; email?: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(data: FormData, mode: "login" | "register"): AuthState["fieldErrors"] {
  const errors: NonNullable<AuthState["fieldErrors"]> = {};
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  if (!email) errors.email = { code: "required" };
  else if (!EMAIL_RE.test(email)) errors.email = { code: "email" };
  if (!password) errors.password = { code: "required" };
  else if (mode === "register" && password.length < 8) errors.password = { code: "passwordMin", params: { min: 8 } };
  if (mode === "register") {
    const name = String(data.get("name") ?? "").trim();
    if (!name) errors.name = { code: "required" };
    else if (name.length < 2) errors.name = { code: "nameMin", params: { min: 2 } };
  }
  return Object.keys(errors).length ? errors : undefined;
}

async function callPlatform(path: string, body: Record<string, unknown>): Promise<AuthState | null> {
  if (!SITE.apiUrl) return { formError: "service.unavailable" };
  try {
    const res = await fetch(`${SITE.apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const payload = (await res.json().catch(() => ({}))) as { code?: string };
    return { formError: payload.code ?? "unknown" };
  } catch {
    return { formError: "service.unavailable" };
  }
}

export async function authAction(_prev: AuthState, data: FormData): Promise<AuthState> {
  const mode = data.get("mode") === "register" ? "register" : "login";
  const rawLocale = String(data.get("locale") ?? "");
  const locale = isActiveLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const values = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? "") };
  const fieldErrors = validate(data, mode);
  if (fieldErrors) return { fieldErrors, values };

  const body = {
    email: String(data.get("email")).trim(),
    password: String(data.get("password")),
    ...(mode === "register" && {
      name: String(data.get("name")).trim(),
      plan: String(data.get("plan") ?? "free"),
      // Saved on the user profile so the app and emails use the same language.
      locale,
    }),
  };

  const result = await callPlatform(mode === "register" ? "/v1/auth/register" : "/v1/auth/login", body);
  if (result) return { ...result, values };

  redirect(localizedPath(locale, mode === "register" ? "/verify-email" : "/dashboard"));
}
