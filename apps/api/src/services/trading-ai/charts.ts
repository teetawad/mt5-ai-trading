import { getMt5Chart } from '../mt5-client';
import { ChartRef } from './types';

// Spec section 5: at minimum M15/H1/H4 chart snapshots, generated server-side
// directly from MT5 OHLC data (never a desktop screenshot).
const CHART_TIMEFRAMES = ['M15', 'H1', 'H4'] as const;

export async function fetchChartSnapshots(symbol: string, requestId?: string): Promise<ChartRef[]> {
  const results = await Promise.allSettled(
    CHART_TIMEFRAMES.map((timeframe) => getMt5Chart(symbol, timeframe, 120, requestId)),
  );
  const charts: ChartRef[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      charts.push({ timeframe: result.value.timeframe, mediaType: result.value.media_type, imageBase64: result.value.image_base64 });
    }
  }
  return charts;
}
