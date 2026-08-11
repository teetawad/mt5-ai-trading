import { Request, Response, NextFunction } from 'express';
import { verifyToken, DecodedToken } from './tokens';
import { isTokenDenied } from './denylist';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: DecodedToken;
    }
  }
}

function extractToken(req: Request): string | null {
  // Prefer cookie (browser sessions)
  const cookie = req.cookies?.session as string | undefined;
  if (cookie) return cookie;

  // Fall back to Authorization: Bearer <token> (API clients / tests)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'No session token provided' });
    return;
  }

  try {
    const decoded = verifyToken(token);
    if (isTokenDenied(decoded.jti)) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Session has been invalidated' });
      return;
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Invalid or expired session token' });
  }
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'No session token provided' });
    return;
  }
  if (req.user.role !== 'owner') {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Owner role required' });
    return;
  }
  next();
}
