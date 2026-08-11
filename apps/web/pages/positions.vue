<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Positions</h1>
      <p class="mt-1 text-sm text-slate-400">Open paper positions reconciled from fills.</p>
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
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="position in data ?? []"
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
            </tr>
            <tr v-if="!(data?.length)">
              <td
                colspan="6"
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
};
const { apiFetch } = useApi();
const { data } = await useAsyncData<Position[]>('positions-page', () => apiFetch('/positions'));
function money(value?: string | null): string {
  return value ? `$${Number(value).toFixed(2)}` : '-';
}
function pnl(value: string): string {
  return Number(value) < 0 ? 'text-rose-300' : 'text-emerald-300';
}
</script>
