import { pino } from "pino";
import { env } from "../config/env.js";

/**
 * Structured logger. Anything that could carry a secret is redacted before it is written:
 * auth headers, cookies, tokens, passwords, OAuth codes and webhook signatures.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "req.headers['x-hub-signature']",
  "req.headers['x-hubspot-signature-v3']",
  "req.headers['x-slack-signature']",
  "req.headers['x-notion-signature']",
  "req.headers['x-shopify-hmac-sha256']",
  "req.headers['stripe-signature']",
  "req.headers['x-telegram-bot-api-secret-token']",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.access_token",
  "*.refreshToken",
  "*.refresh_token",
  "*.clientSecret",
  "*.client_secret",
  "*.secret",
  "*.code",
  "*.codeVerifier",
  "*.csrfToken",
  "*.apiKey",
];

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: "telzyra-api" },
});
