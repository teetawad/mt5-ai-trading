import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { healthRouter } from './routes/health';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan('combined'));
  app.use(express.json());

  app.use('/health', healthRouter);

  return app;
}

export const app = createApp();
