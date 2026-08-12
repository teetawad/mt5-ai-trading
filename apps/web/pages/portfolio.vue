<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Portfolio</h1>
      <p class="page-subtitle">Internal ledger equity, cash, P&L, and reconciliation snapshots from existing portfolio APIs.</p>
    </div>

    <div
      v-if="portfolioError || snapshotsError"
      class="notice-error"
    >
      Failed to load portfolio data. Please refresh the page.
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <MetricBox
        label="Internal Cash"
        :value="money(portfolio?.cashBalance)"
      />
      <MetricBox
        label="Internal Equity"
        :value="money(portfolio?.portfolioEquity)"
      />
      <MetricBox
        label="Realized P&L"
        :value="money(portfolio?.realizedPnl)"
        :class-name="pnl(portfolio?.realizedPnl)"
      />
      <MetricBox
        label="Unrealized P&L"
        :value="money(portfolio?.unrealizedPnl)"
        :class-name="pnl(portfolio?.unrealizedPnl)"
      />
      <MetricBox
        label="Daily P&L"
        :value="money(portfolio?.dailyPnl)"
        :class-name="pnl(portfolio?.dailyPnl)"
      />
    </div>

    <div class="grid gap-4 xl:grid-cols-3">
      <MiniLineChart
        title="Equity History"
        :points="series('portfolioEquity')"
        :value-label="money(portfolio?.portfolioEquity)"
        tone="sky"
      />
      <MiniLineChart
        title="Cash History"
        :points="series('cashBalance')"
        :value-label="money(portfolio?.cashBalance)"
        tone="emerald"
      />
      <MiniLineChart
        title="Daily P&L Trend"
        :points="series('dailyPnl')"
        :value-label="money(portfolio?.dailyPnl)"
        :tone="number(portfolio?.dailyPnl) < 0 ? 'rose' : 'amber'"
      />
      <MiniLineChart
        title="Realized P&L History"
        :points="series('realizedPnl')"
        :value-label="money(portfolio?.realizedPnl)"
        tone="emerald"
      />
      <MiniLineChart
        title="Unrealized P&L History"
        :points="series('unrealizedPnl')"
        :value-label="money(portfolio?.unrealizedPnl)"
        :tone="number(portfolio?.unrealizedPnl) < 0 ? 'rose' : 'sky'"
      />
      <ProgressMeter
        label="Cash vs Equity"
        :percent="cashEquityPercent"
        :value-label="`${money(portfolio?.cashBalance)} cash`"
        status-label="INTERNAL LEDGER"
        :helper="`${cashEquityPercent.toFixed(1)}% of equity is currently held as cash.`"
      />
    </div>

    <UiCard
      title="Snapshots"
      subtitle="Historical portfolio snapshots are used directly for charts. Empty history is shown without invented data."
      body-class="p-0"
    >
      <DataTable
        :empty="!orderedSnapshots.length"
        empty-label="No portfolio snapshots"
        :columns="['Created', 'Cash', 'Equity', 'Daily P&L', 'Reason']"
      >
        <tr
          v-for="snapshot in [...orderedSnapshots].reverse()"
          :key="snapshot.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 text-slate-400">{{ date(snapshot.createdAt) }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(snapshot.cashBalance) }}</td>
          <td class="px-4 py-3 tabular-nums font-semibold text-white">{{ money(snapshot.portfolioEquity) }}</td>
          <td
            class="px-4 py-3 tabular-nums font-medium"
            :class="pnl(snapshot.dailyPnl)"
          >
            {{ money(snapshot.dailyPnl) }}
          </td>
          <td class="px-4 py-3 text-slate-300">{{ snapshot.snapshotReason }}</td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type Portfolio = {
  source: 'INTERNAL_LEDGER';
  cashBalance: string;
  portfolioEquity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  dailyPnl: string;
};
type Snapshot = Portfolio & { id: string; snapshotReason: string; createdAt: string };
type SnapshotKey = 'cashBalance' | 'portfolioEquity' | 'realizedPnl' | 'unrealizedPnl' | 'dailyPnl';

const { apiFetch } = useApi();
const { data: portfolio, error: portfolioError } = await useAsyncData<Portfolio>('portfolio-page-summary', () => apiFetch('/portfolio'));
const { data: snapshots, error: snapshotsError } = await useAsyncData<{ snapshots: Snapshot[] }>('portfolio-page-snapshots', () => apiFetch('/portfolio/snapshots?limit=50'));

const orderedSnapshots = computed(() => [...(snapshots.value?.snapshots ?? [])].reverse());
const cashEquityPercent = computed(() => {
  const cash = number(portfolio.value?.cashBalance);
  const equity = number(portfolio.value?.portfolioEquity);
  return equity > 0 ? (cash / equity) * 100 : 0;
});

function series(key: SnapshotKey) {
  return orderedSnapshots.value.map((snapshot) => ({ label: snapshot.createdAt, value: number(snapshot[key]) }));
}

function number(value?: string): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value?: string): string {
  return `$${number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnl(value?: string): string {
  return number(value) < 0 ? 'text-rose-300' : 'text-emerald-300';
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
