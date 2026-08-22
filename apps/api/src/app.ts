import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { csrfProtection } from './auth/csrf';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { mt5Router } from './routes/mt5';

// Web dev origin plus the schemes a Capacitor iOS WebView presents as its
// page origin (capacitor://localhost in production builds, plain
// http://localhost / ionic://localhost in some simulator/dev configurations).
// Bearer-token requests from the iOS app don't strictly need CORS at all
// (no cookie, no credentialed browser context to protect) but the WKWebView
// still enforces it for any cross-origin fetch/XHR, so the API's allow-list
// must include these origins or a same-origin-looking Capacitor build will
// see every request fail before it even reaches auth.
const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'capacitor://localhost', 'http://localhost', 'ionic://localhost'];

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) return DEFAULT_CORS_ORIGINS;
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function createApp() {
  const app = express();

  // Default helmet() sets Cross-Origin-Resource-Policy: same-origin, which
  // WebKit (the iOS WKWebView engine) enforces client-side even when CORS
  // itself passes — it would silently block the app from reading API
  // responses. `cross-origin` is safe here: this API requires auth on every
  // route that returns anything sensitive (apps/api/src/routes/mt5.ts uses
  // requireAuth/requireOwner throughout), so relaxing CORP does not expose
  // unauthenticated data.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: parseCorsOrigins(),
    credentials: true,
  }));
  app.use(morgan('combined'));
  app.use(express.json());
  app.use(cookieParser());
  app.use(csrfProtection);

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/mt5', mt5Router);

  return app;
}

export const app = createApp();
