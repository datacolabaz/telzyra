import { cookies } from "next/headers";
import { SITE } from "@/config/site";

export const SESSION_COOKIE = "tz_session";

export interface CurrentSession {
  user: { id: string; email: string; name: string; locale: string; emailVerified: boolean };
  workspace: { id: string; name: string; slug: string };
  role: "OWNER" | "ADMIN" | "MEMBER";
  csrfToken: string;
}

/**
 * Server-side session lookup: forwards the visitor's session cookie to the Platform API.
 * Returns null when there is no cookie, the session is invalid, or the API is unreachable.
 * Request-time data: call it inside a <Suspense> boundary.
 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !SITE.apiUrl) return null;
  try {
    const res = await fetch(`${SITE.apiUrl}/v1/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as CurrentSession;
  } catch {
    return null;
  }
}
