import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;    // user ID
  email: string;
  role: string;
}

export interface DecodedToken extends TokenPayload {
  iat: number;
  exp: number;
  jti: string;    // JWT ID for denylist
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET environment variable is required');
  return secret;
}

function getTtl(): number {
  return Number(process.env.SESSION_TTL_SECONDS) || 3600;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    getSecret(),
    { expiresIn: getTtl() },
  );
}

export function verifyToken(token: string): DecodedToken {
  return jwt.verify(token, getSecret()) as DecodedToken;
}
