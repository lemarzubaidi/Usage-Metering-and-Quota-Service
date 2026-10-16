// One error type for everything the client can cause. The HTTP layer turns it into
// { "error": { "code": "...", "message": "...", "details": ... } } with the right status.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'invalid_request', message, details);
export const unauthorized = (message = 'Missing or invalid API key') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

// PostgreSQL error codes we react to (https://www.postgresql.org/docs/16/errcodes-appendix.html)
export const PG_UNIQUE_VIOLATION = '23505';

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
