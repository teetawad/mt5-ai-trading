import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { csrfProtection } from './auth/csrf';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { mt5Router } from './routes/mt5';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
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
