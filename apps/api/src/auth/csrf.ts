import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function makeCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Bearer-token API clients do not participate in browser cookie CSRF.
  if (!req.cookies?.session) {
    next();
    return;
  }

  const cookieToken = req.cookies[CSRF_COOKIE_NAME] as string | undefined;
  const rawHeader = req.headers[CSRF_HEADER_NAME];
  const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({
      error: 'CSRF_TOKEN_INVALID',
      message: 'Missing or invalid CSRF token',
    });
    return;
  }

  next();
}
