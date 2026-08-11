<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-white">Dashboard</h1>
        <p class="mt-1 text-sm text-slate-400">Portfolio, risk state, and current workflow queues.</p>
      </div>
      <div class="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm font-semibold text-amber-200">
        PAPER TRADING
      </div>
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <div class="rounded border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase text-slate-500">Portfolio Equity</p>
        <p class="mt-2 text-2xl font-semibold">{{ currency(portfolio?.portfolioEquity) }}</p>
      </div>
      <div class="rounded border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase text-slate-500">Cash</p>
        <p class="mt-2 text-2xl font-semibold">{{ currency(portfolio?.cashBalance) }}</p>
      </div>
      <div class="rounded border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase text-slate-500">Daily P&L</p>
        <p
          class="mt-2 text-2xl font-semibold"
          :class="pnlClass(portfolio?.dailyPnl)"
        >
          {{ currency(portfolio?.dailyPnl) }}
        </p>
      </div>
      <div class="rounded border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase text-slate-500">Kill Switch</p>
        <p
          class="mt-2 text-2xl font-semibold"
          :class="killSwitch?.enabled ? 'text-emerald-300' : 'text-rose-300'"
        >
          {{ killSwitch?.enabled ? 'Enabled' : 'Disabled' }}
        </p>
      </div>
    </div>

    <div
      v-if="error"
      class="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100"
    >
      {{ error.message }}
    </div>

    <div class="grid gap-6 xl:grid-cols-2">
      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">Pending Proposals</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-slate-500">
              <tr>
                <th class="px-4 py-3">Symbol</th>
                <th class="px-4 py-3">Side</th>
                <th class="px-4 py-3">Qty</th>
                <th class="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="proposal in proposals?.proposals ?? []"
                :key="proposal.id"
                class="border-t border-slate-800"
              >
                <td class="px-4 py-3 font-medium">{{ proposal.symbol }}</td>
                <td class="px-4 py-3">{{ proposal.side }}</td>
                <td class="px-4 py-3">{{ proposal.quantity }}</td>
                <td class="px-4 py-3"><StatusPill :label="proposal.status" /></td>
              </tr>
              <tr v-if="!(proposals?.proposals?.length)">
                <td
                  colspan="4"
                  class="px-4 py-8 text-center text-slate-500"
                >
                  No pending proposals
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">Recent Orders</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-slate-500">
              <tr>
                <th class="px-4 py-3">Symbol</th>
                <th class="px-4 py-3">Side</th>
                <th class="px-4 py-3">Filled</th>
                <th class="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="order in orders?.orders ?? []"
                :key="order.id"
                class="border-t border-slate-800"
              >
                <td class="px-4 py-3 font-medium">{{ order.symbol }}</td>
                <td class="px-4 py-3">{{ order.side }}</td>
                <td class="px-4 py-3">{{ order.filledQuantity }}</td>
                <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
              </tr>
              <tr v-if="!(orders?.orders?.length)">
                <td
                  colspan="4"
                  class="px-4 py-8 text-center text-slate-500"
                >
                  No orders
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type Portfolio = {
  cashBalance: string;
  portfolioEquity: string;
  dailyPnl: string;
};
type ProposalList = { proposals: Array<{ id: string; symbol: string; side: string; quantity: string; status: string }> };
type OrderList = { orders: Array<{ id: string; symbol: string; side: string; filledQuantity: string; status: string }> };
type KillSwitch = { enabled: boolean };

const { apiFetch } = useApi();
const { data: portfolio, error } = await useAsyncData<Portfolio>('dashboard-portfolio', () => apiFetch('/portfolio'));
const { data: killSwitch } = await useAsyncData<KillSwitch>('dashboard-kill-switch', () => apiFetch('/settings/kill-switch'));
const { data: proposals } = await useAsyncData<ProposalList>('dashboard-proposals', () => apiFetch('/trade-proposals?status=PENDING_APPROVAL&limit=8'));
const { data: orders } = await useAsyncData<OrderList>('dashboard-orders', () => apiFetch('/orders?limit=8'));

function currency(value?: string): string {
  return `$${Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlClass(value?: string): string {
  return Number(value ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300';
}
</script>
