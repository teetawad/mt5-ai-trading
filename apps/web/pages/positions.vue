<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Positions</h1>
      <p class="mt-1 text-sm text-slate-400">Open paper positions, priced live from the current market data source.</p>
    </div>
    <div
      v-if="error"
      class="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100"
    >
      Failed to load positions. Please refresh the page.
    </div>
    <div
      v-else-if="data && !data.marketDataStatus.connected"
      class="rounded border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
    >
      DISCONNECTED — the market-data stream is down. Prices below may be out of date.
    </div>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Symbol</th>
              <th class="px-4 py-3">Quantity</th>
              <th class="px-4 py-3">Average Entry</th>
              <th class="px-4 py-3">Last Price</th>
              <th class="px-4 py-3">Realized P&L</th>
              <th class="px-4 py-3">Unrealized P&L</th>
              <th class="px-4 py-3">Freshness</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="position in data?.positions ?? []"
              :key="position.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3 font-medium">{{ position.symbol }}</td>
              <td class="px-4 py-3">{{ position.quantity }}</td>
              <td class="px-4 py-3">{{ money(position.averageEntryPrice) }}</td>
              <td class="px-4 py-3">{{ money(position.lastPrice) }}</td>
              <td
                class="px-4 py-3"
                :class="pnl(position.realizedPnl)"
              >
                {{ money(position.realizedPnl) }}
              </td>
              <td
                class="px-4 py-3"
                :class="pnl(position.unrealizedPnl)"
              >
                {{ money(position.unrealizedPnl) }}
              </td>
              <td class="px-4 py-3">
                <StatusPill :label="position.isStale ? 'STALE' : 'LIVE'" />
              </td>
            </tr>
            <tr v-if="!(data?.positions?.length)">
              <td
                colspan="7"
                class="px-4 py-8 text-center text-slate-500"
              >
                No open positions
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
type Position = {
  id: string;
  symbol: string;
  quantity: string;
  averageEntryPrice: string | null;
  lastPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  isStale: boolean;
  priceAsOf: string | null;
};
type MarketDataStatus = {
  mode: 'stream' | 'poll';
  connected: boolean;
  last_message_at: string | null;
};
type PositionsResponse = {
  positions: Position[];
  marketDataStatus: MarketDataStatus;
  asOf: string;
};
const { apiFetch } = useApi();
const { data, error, refresh } = await useAsyncData<PositionsResponse>('positions-page', () => apiFetch('/positions'));
useAutoRefresh(refresh, 5000);
function money(value?: string | null): string {
  return value ? `$${Number(value).toFixed(2)}` : '-';
}
function pnl(value: string): string {
  return Number(value) < 0 ? 'text-rose-300' : 'text-emerald-300';
}
</script>
