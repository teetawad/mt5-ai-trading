import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getPool } from '../db/client';
import { findUserByEmail } from '../db/repositories/users';
import { createAuditLog } from '../db/repositories/audit-logs';
import { verifyPassword } from '../auth/password';
import { signToken } from '../auth/tokens';
import { denyToken } from '../auth/denylist';
import { requireAuth } from '../auth/middleware';
import { CSRF_COOKIE_NAME, makeCsrfToken } from '../auth/csrf';

export const authRouter = Router();

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 3600;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: SESSION_TTL_SECONDS * 1000,
  path: '/',
};

const CSRF_COOKIE_OPTIONS = {
  ...COOKIE_OPTIONS,
  httpOnly: false,
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' },
});

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

// POST /auth/login
authRouter.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(422).json({
      error: 'VALIDATION_ERROR',
      message: 'email and password are required',
    });
    return;
  }

  const pool = getPool();
  const ipAddress = getClientIp(req);

  const user = await findUserByEmail(pool, email.toLowerCase().trim());

  const isValid = user && user.isActive
    ? await verifyPassword(user.passwordHash, password)
    : false;

  if (!user || !user.isActive || !isValid) {
    await createAuditLog(pool, {
      eventType: 'LOGIN_FAILED',
      actorEmail: typeof email === 'string' ? email.toLowerCase().trim() : null,
      action: 'LOGIN_ATTEMPT_FAILED',
      ipAddress,
      requestId: req.headers['x-request-id'] as string | undefined ?? null,
    });
    res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    return;
  }

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  const csrfToken = makeCsrfToken();

  await createAuditLog(pool, {
    eventType: 'LOGIN_SUCCESS',
    actorId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    action: 'LOGIN',
    ipAddress,
    requestId: req.headers['x-request-id'] as string | undefined ?? null,
  });

  res.cookie('session', token, COOKIE_OPTIONS);
  res.cookie(CSRF_COOKIE_NAME, csrfToken, CSRF_COOKIE_OPTIONS);
  res.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    sessionToken: token,
    csrfToken,
  });
});

// POST /auth/logout
authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;

  denyToken(user.jti, user.exp);

  const pool = getPool();
  await createAuditLog(pool, {
    eventType: 'LOGOUT',
    actorId: user.sub,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.sub,
    action: 'LOGOUT',
    ipAddress: getClientIp(req),
    requestId: req.headers['x-request-id'] as string | undefined ?? null,
  });

  res.clearCookie('session', { path: '/' });
  res.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
  res.json({ message: 'Logged out successfully' });
});

// GET /auth/me
authRouter.get('/me', requireAuth, (_req: Request, res: Response) => {
  const user = _req.user!;
  res.json({
    id: user.sub,
    email: user.email,
    role: user.role,
  });
});
