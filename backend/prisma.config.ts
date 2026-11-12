import { defineConfig } from "prisma/config";

// Local development: load .env if present. In production, DATABASE_URL comes from Railway.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
