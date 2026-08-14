import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { csrfProtection } from './auth/csrf';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { marketDataRouter } from './routes/market-data';
import { riskRouter } from './routes/risk';
import { signalsRouter } from './routes/signals';
import { intradayRouter } from './routes/intraday';
import { cryptoRouter } from './routes/crypto';
import { tradeProposalsRouter } from './routes/trade-proposals';
import { executionsRouter } from './routes/executions';
import { ordersRouter } from './routes/orders';
import { positionsRouter } from './routes/positions';
import { portfolioRouter } from './routes/portfolio';
import { auditLogsRouter } from './routes/audit-logs';
import { settingsRouter } from './routes/settings';
import { dashboardRouter } from './routes/dashboard';

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
  app.use('/market-data', marketDataRouter);
  app.use('/risk', riskRouter);
  app.use('/settings', settingsRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/signals', signalsRouter);
  app.use('/intraday', intradayRouter);
  app.use('/crypto', cryptoRouter);
  app.use('/trade-proposals', tradeProposalsRouter);
  app.use('/executions', executionsRouter);
  app.use('/orders', ordersRouter);
  app.use('/positions', positionsRouter);
  app.use('/portfolio', portfolioRouter);
  app.use('/audit-logs', auditLogsRouter);

  return app;
}

export const app = createApp();
