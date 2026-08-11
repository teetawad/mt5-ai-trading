<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-semibold uppercase text-amber-200">PAPER TRADING ONLY</p>
        <h1 class="text-2xl font-semibold text-white">Alpaca Paper Dashboard</h1>
        <p class="mt-1 text-sm text-slate-400">Paper account, approvals, risk, orders, fills, positions, and reconciliation.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          class="rounded border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-40"
          :disabled="refreshing"
          @click="refreshDashboard"
        >
          Refresh
        </button>
        <button
          class="rounded border px-3 py-2 text-sm font-semibold disabled:opacity-40"
          :class="dashboard?.killSwitch.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
          :disabled="busy || !dashboard"
          @click="toggleKillSwitch"
        >
          {{ dashboard?.killSwitch.enabled ? 'Disable Paper Trading' : 'Enable Paper Trading' }}
        </button>
      </div>
    </div>

    <div class="rounded border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100">
      PAPER TRADING is active on this dashboard. No live trading or real-money execution is available here.
    </div>

    <div
      v-if="error"
      class="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100"
    >
      {{ error.message }}
    </div>
    <div
      v-if="message"
      class="rounded border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-100"
    >
      {{ message }}
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox
        label="Alpaca Paper Connection"
        :value="dashboard?.broker.status ?? 'UNKNOWN'"
        :class-name="statusClass(dashboard?.broker.status)"
      />
      <MetricBox
        label="Paper Buying Power"
        :value="money(dashboard?.broker.buyingPower)"
      />
      <MetricBox
        label="Paper Cash"
        :value="money(dashboard?.broker.cash)"
      />
      <MetricBox
        label="Kill Switch"
        :value="dashboard?.killSwitch.enabled ? 'PAPER ENABLED' : 'PAPER DISABLED'"
        :class-name="dashboard?.killSwitch.enabled ? 'text-emerald-300' : 'text-rose-300'"
      />
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox
        label="Realized P&L"
        :value="money(dashboard?.portfolio.realizedPnl)"
        :class-name="pnlClass(dashboard?.portfolio.realizedPnl)"
      />
      <MetricBox
        label="Unrealized P&L"
        :value="money(dashboard?.portfolio.unrealizedPnl)"
        :class-name="pnlClass(dashboard?.portfolio.unrealizedPnl)"
      />
      <MetricBox
        label="Market Data Freshness"
        :value="dashboard?.marketData.freshness ?? 'UNKNOWN'"
        :class-name="dashboard?.marketData.freshness === 'FRESH' ? 'text-emerald-300' : 'text-amber-300'"
      />
      <MetricBox
        label="Reconciliation"
        :value="dashboard?.reconciliation.status ?? 'UNKNOWN'"
        :class-name="dashboard?.reconciliation.status === 'CONNECTED' ? 'text-emerald-300' : 'text-amber-300'"
      />
    </div>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="flex flex-col gap-1 border-b border-slate-800 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <h2 class="font-semibold">PAPER TRADING Current US Stock Prices</h2>
        <p class="text-xs text-slate-500">Status: {{ dashboard?.marketData.status ?? 'UNKNOWN' }}</p>
      </div>
      <DataTable
        :empty="!(dashboard?.marketData.snapshots.length)"
        empty-label="No market data snapshots"
        :columns="['Symbol', 'Price', 'Bid', 'Ask', 'Timestamp', 'Freshness']"
      >
        <tr
          v-for="snapshot in dashboard?.marketData.snapshots ?? []"
          :key="snapshot.symbol"
          class="border-t border-slate-800"
        >
          <td class="px-4 py-3 font-medium">{{ snapshot.symbol }}</td>
          <td class="px-4 py-3">{{ money(snapshot.price) }}</td>
          <td class="px-4 py-3">{{ money(snapshot.bid) }}</td>
          <td class="px-4 py-3">{{ money(snapshot.ask) }}</td>
          <td class="px-4 py-3">{{ dateTime(snapshot.timestamp) }}</td>
          <td class="px-4 py-3">
            <StatusPill :label="snapshot.isStale ? 'STALE' : 'FRESH'" />
          </td>
        </tr>
      </DataTable>
    </section>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="border-b border-slate-800 px-4 py-3">
        <h2 class="font-semibold">PAPER TRADING Pending Proposals</h2>
      </div>
      <DataTable
        :empty="!(dashboard?.pendingProposals.length)"
        empty-label="No pending trade proposals"
        :columns="['Symbol', 'Side', 'Qty', 'Reference', 'Risk', 'Expires', 'Actions']"
      >
        <tr
          v-for="proposal in dashboard?.pendingProposals ?? []"
          :key="proposal.id"
          class="border-t border-slate-800"
        >
          <td class="px-4 py-3 font-medium">{{ proposal.symbol }}</td>
          <td class="px-4 py-3">{{ proposal.side }}</td>
          <td class="px-4 py-3">{{ proposal.quantity }}</td>
          <td class="px-4 py-3">{{ money(proposal.referencePrice) }}</td>
          <td class="px-4 py-3"><StatusPill :label="proposal.riskSnapshot?.result ?? proposal.status" /></td>
          <td class="px-4 py-3">{{ dateTime(proposal.expiresAt) }}</td>
          <td class="px-4 py-3">
            <div class="flex justify-end gap-2">
              <button
                class="rounded border border-emerald-500/50 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                :disabled="busy || proposal.status !== 'PENDING_APPROVAL'"
                @click="approve(proposal.id)"
              >
                Approve
              </button>
              <button
                class="rounded border border-rose-500/50 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-40"
                :disabled="busy || proposal.status !== 'PENDING_APPROVAL'"
                @click="reject(proposal.id)"
              >
                Reject
              </button>
            </div>
          </td>
        </tr>
      </DataTable>
    </section>

    <div class="grid gap-6 xl:grid-cols-2">
      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">PAPER TRADING Risk Results</h2>
        </div>
        <DataTable
          :empty="!(dashboard?.riskResults.length)"
          empty-label="No risk results"
          :columns="['Stage', 'Result', 'Failed Rules', 'Created']"
        >
          <tr
            v-for="risk in dashboard?.riskResults ?? []"
            :key="risk.id"
            class="border-t border-slate-800"
          >
            <td class="px-4 py-3">{{ risk.stage }}</td>
            <td class="px-4 py-3"><StatusPill :label="risk.result" /></td>
            <td class="px-4 py-3">{{ risk.failedRules.length ? risk.failedRules.join(', ') : '-' }}</td>
            <td class="px-4 py-3">{{ dateTime(risk.createdAt) }}</td>
          </tr>
        </DataTable>
      </section>

      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">PAPER TRADING Reconciliation</h2>
        </div>
        <dl class="grid gap-4 p-4 text-sm md:grid-cols-2">
          <div>
            <dt class="text-xs uppercase text-slate-500">Status</dt>
            <dd
              class="mt-1 font-semibold"
              :class="dashboard?.reconciliation.status === 'CONNECTED' ? 'text-emerald-300' : 'text-amber-300'"
            >
              {{ dashboard?.reconciliation.status ?? 'UNKNOWN' }}
            </dd>
          </div>
          <div>
            <dt class="text-xs uppercase text-slate-500">Checked</dt>
            <dd class="mt-1 font-semibold">{{ dateTime(dashboard?.reconciliation.checkedAt) }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase text-slate-500">Open Positions</dt>
            <dd class="mt-1 font-semibold">{{ dashboard?.reconciliation.openPositionCount ?? 0 }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase text-slate-500">Pending Paper Orders</dt>
            <dd class="mt-1 font-semibold">{{ dashboard?.reconciliation.pendingOrderCount ?? 0 }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="border-b border-slate-800 px-4 py-3">
        <h2 class="font-semibold">PAPER TRADING Alpaca Open Broker Orders</h2>
      </div>
      <DataTable
        :empty="!(dashboard?.brokerOpenOrders.length)"
        empty-label="No open Alpaca paper broker orders"
        :columns="['Broker Order', 'Status', 'Fills', 'Rejected', 'Error']"
      >
        <tr
          v-for="order in dashboard?.brokerOpenOrders ?? []"
          :key="order.broker_order_id"
          class="border-t border-slate-800"
        >
          <td class="px-4 py-3 font-medium">{{ order.broker_order_id }}</td>
          <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
          <td class="px-4 py-3">{{ order.fills.length }}</td>
          <td class="px-4 py-3">{{ order.rejected_reason ?? '-' }}</td>
          <td class="px-4 py-3">{{ order.error_message ?? '-' }}</td>
        </tr>
      </DataTable>
    </section>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="border-b border-slate-800 px-4 py-3">
        <h2 class="font-semibold">PAPER TRADING Persisted Orders</h2>
      </div>
      <DataTable
        :empty="!(dashboard?.orders.length)"
        empty-label="No paper orders"
        :columns="['Symbol', 'Side', 'Type', 'Qty', 'Filled', 'Avg Fill', 'Status']"
      >
        <tr
          v-for="order in dashboard?.orders ?? []"
          :key="order.id"
          class="border-t border-slate-800"
        >
          <td class="px-4 py-3 font-medium">{{ order.symbol }}</td>
          <td class="px-4 py-3">{{ order.side }}</td>
          <td class="px-4 py-3">{{ order.orderType }}</td>
          <td class="px-4 py-3">{{ order.quantity }}</td>
          <td class="px-4 py-3">{{ order.filledQuantity }}</td>
          <td class="px-4 py-3">{{ money(order.averageFillPrice) }}</td>
          <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
        </tr>
      </DataTable>
    </section>

    <div class="grid gap-6 xl:grid-cols-2">
      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">PAPER TRADING Fills</h2>
        </div>
        <DataTable
          :empty="!(dashboard?.fills.length)"
          empty-label="No paper fills"
          :columns="['Quantity', 'Price', 'Fee', 'Type', 'Filled']"
        >
          <tr
            v-for="fill in dashboard?.fills ?? []"
            :key="fill.id"
            class="border-t border-slate-800"
          >
            <td class="px-4 py-3">{{ fill.quantity }}</td>
            <td class="px-4 py-3">{{ money(fill.price) }}</td>
            <td class="px-4 py-3">{{ money(fill.fee) }}</td>
            <td class="px-4 py-3">{{ fill.fillType }}</td>
            <td class="px-4 py-3">{{ dateTime(fill.filledAt) }}</td>
          </tr>
        </DataTable>
      </section>

      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3">
          <h2 class="font-semibold">PAPER TRADING Positions</h2>
        </div>
        <DataTable
          :empty="!(dashboard?.positions.length)"
          empty-label="No paper positions"
          :columns="['Symbol', 'Qty', 'Entry', 'Last', 'Realized', 'Unrealized']"
        >
          <tr
            v-for="position in dashboard?.positions ?? []"
            :key="position.id"
            class="border-t border-slate-800"
          >
            <td class="px-4 py-3 font-medium">{{ position.symbol }}</td>
            <td class="px-4 py-3">{{ position.quantity }}</td>
            <td class="px-4 py-3">{{ money(position.averageEntryPrice) }}</td>
            <td class="px-4 py-3">{{ money(position.lastPrice) }}</td>
            <td
              class="px-4 py-3"
              :class="pnlClass(position.realizedPnl)"
            >
              {{ money(position.realizedPnl) }}
            </td>
            <td
              class="px-4 py-3"
              :class="pnlClass(position.unrealizedPnl)"
            >
              {{ money(position.unrealizedPnl) }}
            </td>
          </tr>
        </DataTable>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type ExternalStatus = 'CONNECTED' | 'UNAVAILABLE' | 'RATE_LIMITED';
type Proposal = {
  id: string;
  symbol: string;
  side: string;
  quantity: string;
  referencePrice: string;
  status: string;
  expiresAt: string;
  riskSnapshot: { result?: string } | null;
};
type RiskResult = { id: string; stage: string; result: string; failedRules: string[]; createdAt: string };
type Order = {
  id: string;
  symbol: string;
  side: string;
  orderType: string;
  quantity: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  status: string;
};
type BrokerOrder = {
  broker_order_id: string;
  status: string;
  fills: unknown[];
  rejected_reason?: string | null;
  error_message?: string | null;
};
type Fill = { id: string; quantity: string; price: string; fee: string; fillType: string; filledAt: string };
type Position = {
  id: string;
  symbol: string;
  quantity: string;
  averageEntryPrice: string | null;
  lastPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
};
type MarketSnapshot = {
  symbol: string;
  price: string;
  bid: string;
  ask: string;
  volume: number;
  timestamp: string;
  isStale: boolean;
};
type Dashboard = {
  tradingMode: 'PAPER';
  paperTrading: boolean;
  broker: {
    provider: string;
    tradingMode: 'PAPER';
    status: ExternalStatus;
    accountStatus: ExternalStatus;
    cash: string;
    buyingPower: string;
    accountId: string | null;
    currency: string | null;
    alpacaStatus: string | null;
  };
  portfolio: {
    cashBalance: string;
    portfolioEquity: string;
    realizedPnl: string;
    unrealizedPnl: string;
    dailyPnl: string;
    lastUpdatedAt: string | null;
  };
  marketData: {
    status: ExternalStatus;
    freshness: 'FRESH' | 'STALE';
    staleCount: number;
    snapshots: MarketSnapshot[];
  };
  reconciliation: {
    status: 'CONNECTED' | 'NEEDS_ATTENTION';
    checkedAt: string;
    openPositionCount: number;
    pendingOrderCount: number;
  };
  killSwitch: { enabled: boolean };
  pendingProposals: Proposal[];
  riskResults: RiskResult[];
  orders: Order[];
  brokerOpenOrders: BrokerOrder[];
  fills: Fill[];
  positions: Position[];
};

const { apiFetch } = useApi();
const message = ref('');
const busy = ref(false);
const refreshing = ref(false);
const { data: dashboard, error, refresh } = await useAsyncData<Dashboard>('paper-dashboard', () => apiFetch('/dashboard/paper'));

async function refreshDashboard() {
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}

async function approve(id: string) {
  busy.value = true;
  message.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/approve`, { method: 'POST', body: { requestId: crypto.randomUUID() } });
    message.value = 'PAPER TRADING proposal approved.';
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function reject(id: string) {
  busy.value = true;
  message.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/reject`, {
      method: 'POST',
      body: { requestId: crypto.randomUUID(), reason: 'Rejected from PAPER TRADING dashboard' },
    });
    message.value = 'PAPER TRADING proposal rejected.';
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function toggleKillSwitch() {
  if (!dashboard.value) return;
  busy.value = true;
  message.value = '';
  try {
    await apiFetch('/settings/kill-switch', {
      method: 'PUT',
      body: { enabled: !dashboard.value.killSwitch.enabled },
    });
    message.value = 'PAPER TRADING kill switch updated.';
    await refresh();
  } finally {
    busy.value = false;
  }
}

function money(value?: string | null): string {
  return value ? `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-';
}

function dateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function pnlClass(value?: string | null): string {
  return Number(value ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300';
}

function statusClass(value?: string): string {
  if (value === 'CONNECTED') return 'text-emerald-300';
  if (value === 'RATE_LIMITED') return 'text-amber-300';
  return 'text-rose-300';
}
</script>
