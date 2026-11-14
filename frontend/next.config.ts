import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Optional same-origin API proxy (TELZYRA_API_PROXY=1): the browser calls <site>/api/v1/* and Next.js
 * forwards to TELZYRA_API_URL/v1/*. Used for local testing in browsers that block cross-port requests
 * to localhost (e.g. embedded browser panes). Production calls the API origin directly (off by default).
 */
const apiProxy = process.env.TELZYRA_API_PROXY === "1" && process.env.TELZYRA_API_URL;

const nextConfig: NextConfig = {
  cacheComponents: true,
  ...(apiProxy
    ? { rewrites: async () => [{ source: "/api/v1/:path*", destination: `${process.env.TELZYRA_API_URL}/v1/:path*` }] }
    : {}),
  partialPrefetching: true,
  turbopack: {
    // Pin the project root so a workspace file in a parent folder is never picked up.
    root: dirname(fileURLToPath(import.meta.url)),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
