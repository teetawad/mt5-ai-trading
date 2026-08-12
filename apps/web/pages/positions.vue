<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
        <h1 class="page-title">Positions</h1>
        <p class="page-subtitle">Open paper positions, priced from the current market data source with allocation and unrealized P&L visuals.</p>
      </div>
      <StatusPill :label="data?.marketDataStatus.connected ? 'LIVE' : 'STALE'" />
    </div>

    <div
      v-if="error"
      class="notice-error"
    >
      Failed to load positions. Please refresh the page.
    </div>
    <div
      v-else-if="data && !data.marketDataStatus.connected"
      class="notice-warn"
    >
      DISCONNECTED - the market-data stream is down. Prices below may be out of date.
    </div>

    <div class="grid gap-4 xl:grid-cols-3">
      <DonutChart
        title="Allocation by Symbol"
        :data="allocationData"
        :formatter="moneyNumber"
      />
      <BarChart
        title="Open Position Value"
        :data="positionValueData"
        :formatter="moneyNumber"
      />
      <BarChart
        title="Unrealized P&L by Position"
        :data="unrealizedData"
        :formatter="moneyNumber"
      />
    </div>

    <UiCard
      title="Open Positions"
      :subtitle="`As of ${date(data?.asOf)}`"
      body-class="p-0"
    >
      <DataTable
        :empty="!(data?.positions?.length)"
        empty-label="No open positions"
        :columns="['Symbol', 'Quantity', 'Average Entry', 'Last Price', 'Market Value', 'Realized P&L', 'Unrealized P&L', 'Freshness']"
      >
        <tr
          v-for="position in data?.positions ?? []"
          :key="position.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 font-semibold text-white">{{ position.symbol }}</td>
          <td class="px-4 py-3 tabular-nums">{{ position.quantity }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(position.averageEntryPrice) }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(position.lastPrice) }}</td>
          <td class="px-4 py-3 tabular-nums font-medium">{{ moneyNumber(positionValue(position)) }}</td>
          <td
            class="px-4 py-3 tabular-nums font-medium"
            :class="pnl(position.realizedPnl)"
          >
            {{ money(position.realizedPnl) }}
          </td>
          <td
            class="px-4 py-3 tabular-nums font-medium"
            :class="pnl(position.unrealizedPnl)"
          >
            {{ money(position.unrealizedPnl) }}
          </td>
          <td class="px-4 py-3">
            <StatusPill :label="position.isStale ? 'STALE' : 'LIVE'" />
          </td>
        </tr>
      </DataTable>
    </UiCard>
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

const allocationData = computed(() => (data.value?.positions ?? []).map((position) => ({
  label: position.symbol,
  value: positionValue(position),
})));
const positionValueData = computed(() => allocationData.value);
const unrealizedData = computed(() => (data.value?.positions ?? []).map((position) => ({
  label: position.symbol,
  value: number(position.unrealizedPnl),
})));

function positionValue(position: Position): number {
  return number(position.quantity) * number(position.lastPrice);
}

function number(value?: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value?: string | null): string {
  return value ? moneyNumber(number(value)) : '-';
}

function moneyNumber(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnl(value: string): string {
  return number(value) < 0 ? 'text-rose-300' : 'text-emerald-300';
}

function date(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}
</script>
