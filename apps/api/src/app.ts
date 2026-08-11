import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { marketDataRouter } from './routes/market-data';
import { riskRouter } from './routes/risk';
import { signalsRouter } from './routes/signals';
import { tradeProposalsRouter } from './routes/trade-proposals';

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

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/market-data', marketDataRouter);
  app.use('/risk', riskRouter);
  app.use('/signals', signalsRouter);
  app.use('/trade-proposals', tradeProposalsRouter);

  return app;
}

export const app = createApp();
