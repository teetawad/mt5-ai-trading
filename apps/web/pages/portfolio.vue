<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Portfolio</h1>
      <p class="mt-1 text-sm text-slate-400">Internal ledger equity, cash, P&L, and reconciliation snapshots.</p>
    </div>
    <div class="grid gap-3 md:grid-cols-4">
      <div
        v-for="metric in metrics"
        :key="metric.label"
        class="rounded border border-slate-800 bg-slate-900 p-4"
      >
        <p class="text-xs uppercase text-slate-500">{{ metric.label }}</p>
        <p
          class="mt-2 text-2xl font-semibold"
          :class="metric.className"
        >
          {{ metric.value }}
        </p>
      </div>
    </div>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="border-b border-slate-800 px-4 py-3">
        <h2 class="font-semibold">Snapshots</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Created</th>
              <th class="px-4 py-3">Cash</th>
              <th class="px-4 py-3">Equity</th>
              <th class="px-4 py-3">Daily P&L</th>
              <th class="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="snapshot in snapshots?.snapshots ?? []"
              :key="snapshot.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3">{{ date(snapshot.createdAt) }}</td>
              <td class="px-4 py-3">{{ money(snapshot.cashBalance) }}</td>
              <td class="px-4 py-3">{{ money(snapshot.portfolioEquity) }}</td>
              <td
                class="px-4 py-3"
                :class="pnl(snapshot.dailyPnl)"
              >
                {{ money(snapshot.dailyPnl) }}
              </td>
              <td class="px-4 py-3">{{ snapshot.snapshotReason }}</td>
            </tr>
            <tr v-if="!(snapshots?.snapshots?.length)">
              <td
                colspan="5"
                class="px-4 py-8 text-center text-slate-500"
              >
                No snapshots
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
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
const { apiFetch } = useApi();
const { data: portfolio } = await useAsyncData<Portfolio>('portfolio-page-summary', () => apiFetch('/portfolio'));
const { data: snapshots } = await useAsyncData<{ snapshots: Snapshot[] }>('portfolio-page-snapshots', () => apiFetch('/portfolio/snapshots?limit=50'));

const metrics = computed(() => [
  { label: 'Internal Cash', value: money(portfolio.value?.cashBalance), className: '' },
  { label: 'Internal Equity', value: money(portfolio.value?.portfolioEquity), className: '' },
  { label: 'Realized P&L', value: money(portfolio.value?.realizedPnl), className: pnl(portfolio.value?.realizedPnl) },
  { label: 'Unrealized P&L', value: money(portfolio.value?.unrealizedPnl), className: pnl(portfolio.value?.unrealizedPnl) },
]);

function money(value?: string): string {
  return `$${Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pnl(value?: string): string {
  return Number(value ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300';
}
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
