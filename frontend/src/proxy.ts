import { NextResponse, type NextRequest } from "next/server";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isActiveLocale,
} from "@/i18n/config";

/**
 * Locale resolution. Explicit only: URL prefix, then the user's saved choice (cookie).
 * There is no IP-based or Accept-Language-based redirect.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";

  // 0. One canonical host: www.telzyra.com/* -> telzyra.com/* (avoids duplicate content).
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  if (host.startsWith("www.")) {
    return NextResponse.redirect(`https://${host.slice(4)}${pathname}${search}`, 308);
  }

  // Private app routes: without a session cookie go straight to the localized login page.
  // (Optimistic check only; the page itself validates the session with the API.)
  const localePrefix = isActiveLocale(first) && first !== DEFAULT_LOCALE ? `/${first}` : "";
  const appPath = localePrefix ? pathname.slice(localePrefix.length) || "/" : pathname;
  if ((appPath === "/dashboard" || appPath.startsWith("/dashboard/")) && !request.cookies.has("tz_session")) {
    const url = request.nextUrl.clone();
    url.pathname = `${localePrefix}/login`;
    url.search = "";
    return NextResponse.redirect(url, 307);
  }

  // 1. "/en" and "/en/*" -> unprefixed canonical English URL.
  if (first === DEFAULT_LOCALE) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(DEFAULT_LOCALE.length + 1) || "/";
    const res = NextResponse.redirect(url, 308);
    res.cookies.set(LOCALE_COOKIE, DEFAULT_LOCALE, cookieOptions());
    return res;
  }

  // 2. Active non-default prefix: serve as-is.
  if (isActiveLocale(first)) return NextResponse.next();

  // 3. Planned (not yet active) locale prefix: let the router return 404.
  if ((ALL_LOCALES as string[]).includes(first)) return NextResponse.next();

  // 4. Unprefixed path. Honour a remembered explicit choice, otherwise English.
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isActiveLocale(saved) && saved !== DEFAULT_LOCALE) {
    const url = request.nextUrl.clone();
    url.pathname = `/${saved}${pathname === "/" ? "" : pathname}`;
    const res = NextResponse.redirect(url, 307);
    res.headers.set("Vary", "Cookie");
    return res;
  }

  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === "/" ? "" : pathname}`;
  url.search = search;
  return NextResponse.rewrite(url);
}

function cookieOptions() {
  return { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" as const };
}

export const config = {
  // Skip Next internals, API routes and any file with an extension (sitemap.xml, robots.txt, images).
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
