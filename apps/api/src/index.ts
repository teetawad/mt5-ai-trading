import { app } from './app';

const PORT = Number(process.env.API_PORT) || 4000;
const HOST = process.env.API_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[api] Paper Trading API running at http://${HOST}:${PORT}`);
  console.log('[api] Mode: PAPER TRADING — no real-money execution');
});
