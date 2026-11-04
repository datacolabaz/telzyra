# Russian (ru) — planned

Russian is registered in `src/i18n/config.ts` with `status: "planned"`. Its routes
(`/ru/*`) return 404 and it is excluded from hreflang and the sitemap.

To launch:
1. Add professionally translated copies of every file in `../en/` to this folder
   (same file names, same keys, same `{placeholders}`).
2. Run `npm run i18n:check`. It must report 0 issues for `ru`.
3. Set `ru.status = "active"` in `src/i18n/config.ts`.

Do not ship machine translations. Any key that is missing falls back to English at runtime.
