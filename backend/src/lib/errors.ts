/**
 * Application errors carry a stable, language-neutral `code`.
 * The frontend maps codes to localized messages (messages/<locale>/validation.json).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (fields: Record<string, { code: string; params?: Record<string, number> }>) =>
    new AppError(400, "validation", { fields }),
  unauthorized: () => new AppError(401, "auth.unauthorized"),
  invalidCredentials: () => new AppError(401, "auth.invalid_credentials"),
  emailTaken: () => new AppError(409, "auth.email_taken"),
  csrf: () => new AppError(403, "auth.csrf_failed"),
  forbidden: () => new AppError(403, "auth.forbidden"),
  notFound: () => new AppError(404, "not_found"),
  rateLimited: () => new AppError(429, "rate_limited"),
};
