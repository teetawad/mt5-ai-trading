<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
        <h1 class="page-title">Paper Trading Dashboard</h1>
        <p class="page-subtitle">Internal ledger, Alpaca paper account state, approvals, risk checks, orders, fills, positions, and reconciliation.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          class="btn-primary"
          :disabled="refreshing"
          @click="refreshDashboard"
        >
          {{ refreshing ? 'Refreshing...' : 'Refresh' }}
        </button>
        <button
          class="rounded-lg border px-4 py-2 text-sm font-semibold transition disabled:opacity-40"
          :class="dashboard?.killSwitch.enabled ? 'border-rose-400/50 bg-rose-400/10 text-rose-100 hover:bg-rose-400/20' : 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20'"
          :disabled="busy || !dashboard"
          @click="toggleKillSwitch"
        >
          {{ dashboard?.killSwitch.enabled ? 'Disable Paper Trading' : 'Enable Paper Trading' }}
        </button>
      </div>
    </div>

    <div class="notice-warn">
      PAPER TRADING is active on this dashboard. No live trading or real-money execution is available here.
    </div>
    <div
      v-if="error"
      class="notice-error"
    >
      {{ error.message }}
    </div>
    <div
      v-if="snapshotsError"
      class="notice-error"
    >
      Portfolio history could not be loaded. Current-state cards remain available.
    </div>
    <div
      v-if="actionError"
      class="notice-error"
    >
      {{ actionError }}
    </div>
    <div
      v-if="message"
      class="notice-info"
    >
      {{ message }}
    </div>
    <div
      v-if="dashboard && dashboard.marketData.streamMode === 'stream' && !dashboard.marketData.streamConnected"
      class="notice-warn"
    >
      DISCONNECTED - the market-data stream is down. Prices shown may be out of date.
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox
        label="Alpaca Paper Connection"
        :value="dashboard?.broker.status ?? 'UNKNOWN'"
        :class-name="statusClass(dashboard?.broker.status)"
      />
      <MetricBox
        label="Portfolio Equity"
        :value="money(dashboard?.portfolio.portfolioEquity)"
      />
      <MetricBox
        label="Internal Ledger Cash"
        :value="money(dashboard?.portfolio.cashBalance)"
      />
      <MetricBox
        label="Kill Switch"
        :value="dashboard?.killSwitch.enabled ? 'PAPER ENABLED' : 'PAPER DISABLED'"
        :class-name="dashboard?.killSwitch.enabled ? 'text-emerald-300' : 'text-rose-300'"
      />
    </div>

    <div class="grid gap-4 xl:grid-cols-4">
      <MiniLineChart
        class="xl:col-span-2"
        title="Equity Curve"
        :points="equityHistory"
        :value-label="money(dashboard?.portfolio.portfolioEquity)"
        tone="sky"
      />
      <MiniLineChart
        title="Portfolio Value (Historical Snapshots)"
        :points="portfolioValueTrend"
        :value-label="latestSnapshot ? `${money(latestSnapshot.portfolioEquity)} as of ${dateTime(latestSnapshot.createdAt)}` : 'No snapshot yet'"
        tone="emerald"
      />
      <BarChart
        title="Realized vs Unrealized P&L"
        :data="pnlBars"
        :formatter="moneyNumber"
      />
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <ProgressMeter
        label="Cash vs Equity"
        :percent="cashEquityPercent"
        :value-label="`${money(dashboard?.portfolio.cashBalance)} cash`"
        status-label="INTERNAL LEDGER"
        :helper="`${cashEquityPercent.toFixed(1)}% of current equity is cash.`"
      />
      <ProgressMeter
        label="Open Positions"
        :percent="positionCapacityPercent"
        :value-label="`${dashboard?.positions.length ?? 0} open`"
        status-label="PAPER ONLY"
        helper="Current open positions from the internal ledger."
      />
      <ProgressMeter
        label="Active Proposals"
        :percent="proposalPressurePercent"
        :value-label="`${dashboard?.pendingProposals.length ?? 0} pending`"
        status-label="OWNER APPROVAL"
        helper="Pending proposals still require owner approval before paper execution."
      />
    </div>

    <UiCard
      title="Current Market Prices (US Stocks + Crypto)"
      :subtitle="`Freshness: ${dashboard?.marketData.freshness ?? 'UNKNOWN'} / Status: ${dashboard?.marketData.status ?? 'UNKNOWN'}`"
      body-class="p-0"
    >
      <DataTable
        :empty="!(dashboard?.marketData.snapshots.length)"
        empty-label="No market data snapshots"
        :columns="['Symbol', 'Market', 'Price', 'Bid', 'Ask', 'Timestamp', 'Freshness']"
      >
        <tr
          v-for="snapshot in dashboard?.marketData.snapshots ?? []"
          :key="snapshot.symbol"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 font-semibold text-white">{{ snapshot.symbol }}</td>
          <td class="px-4 py-3"><StatusPill :label="assetClassOf(snapshot.symbol)" /></td>
          <td class="px-4 py-3 font-medium tabular-nums">{{ money(snapshot.price) }}</td>
          <td class="px-4 py-3 tabular-nums text-slate-300">{{ money(snapshot.bid) }}</td>
          <td class="px-4 py-3 tabular-nums text-slate-300">{{ money(snapshot.ask) }}</td>
          <td class="px-4 py-3 text-slate-400">{{ dateTime(snapshot.timestamp) }}</td>
          <td class="px-4 py-3">
            <StatusPill :label="snapshot.isStale ? 'STALE' : 'FRESH'" />
          </td>
        </tr>
      </DataTable>
    </UiCard>

    <UiCard
      title="Pending Proposals"
      subtitle="AI decision and Risk Engine decision are shown separately. Approval controls preserve the existing owner approval flow."
      body-class="p-0"
    >
      <DataTable
        :empty="!(dashboard?.pendingProposals.length)"
        empty-label="No pending trade proposals"
        :columns="['Symbol', 'Side', 'Qty', 'Entry', 'Stop', 'Target', 'Risk Engine', 'Actions']"
      >
        <tr
          v-for="proposal in dashboard?.pendingProposals ?? []"
          :key="proposal.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 font-semibold text-white">
            <div class="flex items-center gap-2">
              <span>{{ proposal.symbol }}</span>
              <StatusPill :label="proposal.assetClass" />
            </div>
          </td>
          <td class="px-4 py-3">{{ proposal.side }}</td>
          <td class="px-4 py-3 tabular-nums">{{ proposal.quantity }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(proposal.riskSnapshot?.phase22?.entry ?? proposal.referencePrice) }}</td>
          <td class="px-4 py-3 tabular-nums text-rose-200">{{ money(proposal.riskSnapshot?.phase22?.stopLoss) }}</td>
          <td class="px-4 py-3 tabular-nums text-emerald-200">{{ money(proposal.riskSnapshot?.phase22?.takeProfit) }}</td>
          <td class="px-4 py-3"><StatusPill :label="proposal.riskSnapshot?.result ?? proposal.status" /></td>
          <td class="px-4 py-3">
            <div class="flex justify-end gap-2">
              <button
                class="btn-success"
                :disabled="busy || proposal.status !== 'PENDING_APPROVAL'"
                @click="approve(proposal.id)"
              >
                Approve
              </button>
              <button
                class="btn-danger"
                :disabled="busy || proposal.status !== 'PENDING_APPROVAL'"
                @click="reject(proposal.id)"
              >
                Reject
              </button>
            </div>
          </td>
        </tr>
      </DataTable>
    </UiCard>

    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard
        title="Risk Results"
        subtitle="Latest Risk Engine pass/fail decisions."
        body-class="p-0"
      >
        <DataTable
          :empty="!(dashboard?.riskResults.length)"
          empty-label="No risk results"
          :columns="['Stage', 'Result', 'Failed Rules', 'Created']"
        >
          <tr
            v-for="risk in dashboard?.riskResults ?? []"
            :key="risk.id"
            class="border-t border-slate-800/80 hover:bg-slate-800/40"
          >
            <td class="px-4 py-3 font-medium">{{ risk.stage }}</td>
            <td class="px-4 py-3"><StatusPill :label="risk.result" /></td>
            <td class="px-4 py-3 text-slate-300">{{ Array.isArray(risk.failedRules) && risk.failedRules.length ? risk.failedRules.join(', ') : '-' }}</td>
            <td class="px-4 py-3 text-slate-400">{{ dateTime(risk.createdAt) }}</td>
          </tr>
        </DataTable>
      </UiCard>

      <UiCard
        title="Reconciliation"
        subtitle="Internal ledger compared with the Alpaca paper account."
      >
        <dl class="grid gap-4 text-sm md:grid-cols-2">
          <div
            v-for="item in reconciliationItems"
            :key="item.label"
            class="rounded-lg border border-slate-800 bg-slate-950/50 p-3"
          >
            <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ item.label }}</dt>
            <dd
              class="mt-1 font-semibold text-slate-100"
              :class="item.className"
            >
              {{ item.value }}
            </dd>
          </div>
        </dl>
      </UiCard>
    </div>

    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard
        title="Persisted Orders"
        body-class="p-0"
      >
        <DataTable
          :empty="!(dashboard?.orders.length)"
          empty-label="No paper orders"
          :columns="['Symbol', 'Side', 'Type', 'Qty', 'Filled', 'Avg Fill', 'Status']"
        >
          <tr
            v-for="order in dashboard?.orders ?? []"
            :key="order.id"
            class="border-t border-slate-800/80 hover:bg-slate-800/40"
          >
            <td class="px-4 py-3 font-semibold text-white">
              <div class="flex items-center gap-2">
                <span>{{ order.symbol }}</span>
                <StatusPill :label="order.assetClass" />
              </div>
            </td>
            <td class="px-4 py-3">{{ order.side }}</td>
            <td class="px-4 py-3">{{ order.orderType }}</td>
            <td class="px-4 py-3 tabular-nums">{{ order.quantity }}</td>
            <td class="px-4 py-3 tabular-nums">{{ order.filledQuantity }}</td>
            <td class="px-4 py-3 tabular-nums">{{ money(order.averageFillPrice) }}</td>
            <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
          </tr>
        </DataTable>
      </UiCard>

      <UiCard
        title="Positions"
        body-class="p-0"
      >
        <DataTable
          :empty="!(dashboard?.positions.length)"
          empty-label="No paper positions"
          :columns="['Symbol', 'Qty', 'Entry', 'Last', 'Market Value', 'Realized (All-Time)', 'Unrealized']"
        >
          <tr
            v-for="position in dashboard?.positions ?? []"
            :key="position.id"
            class="border-t border-slate-800/80 hover:bg-slate-800/40"
          >
            <td class="px-4 py-3 font-semibold text-white">
              <div class="flex items-center gap-2">
                <span>{{ position.symbol }}</span>
                <StatusPill :label="position.assetClass" />
              </div>
            </td>
            <td class="px-4 py-3 tabular-nums">{{ position.quantity }}</td>
            <td class="px-4 py-3 tabular-nums">{{ money(position.averageEntryPrice) }}</td>
            <td class="px-4 py-3 tabular-nums">{{ money(position.lastPrice) }}</td>
            <td class="px-4 py-3 tabular-nums font-medium">{{ money(position.marketValue) }}</td>
            <td
              class="px-4 py-3 tabular-nums font-medium"
              :class="pnlClass(position.realizedPnl)"
              title="Cumulative realized P&L booked on this symbol across all closed lots, not just the current open position."
            >
              {{ money(position.realizedPnl) }}
            </td>
            <td
              class="px-4 py-3 tabular-nums font-medium"
              :class="pnlClass(position.unrealizedPnl)"
            >
              {{ money(position.unrealizedPnl) }}
            </td>
          </tr>
        </DataTable>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
type ExternalStatus = 'CONNECTED' | 'UNAVAILABLE' | 'RATE_LIMITED';
type Proposal = {
  id: string;
  symbol: string;
  assetClass: 'STOCK' | 'CRYPTO';
  side: string;
  quantity: string;
  referencePrice: string;
  status: string;
  expiresAt: string;
  riskSnapshot: {
    result?: string;
    phase22?: {
      entry?: string;
      stopLoss?: string;
      takeProfit?: string;
      maxLoss?: string;
    };
  } | null;
};
type RiskResult = { id: string; stage: string; result: string; failedRules: string[]; createdAt: string };
type Order = {
  id: string;
  symbol: string;
  assetClass: 'STOCK' | 'CRYPTO';
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
  assetClass: 'STOCK' | 'CRYPTO';
  quantity: string;
  averageEntryPrice: string | null;
  lastPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  marketValue: string;
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
    source: 'ALPACA_PAPER_ACCOUNT';
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
    source: 'INTERNAL_LEDGER';
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
    streamMode: 'stream' | 'poll';
    streamConnected: boolean;
    streamLastMessageAt: string | null;
    snapshots: MarketSnapshot[];
  };
  reconciliation: {
    status: 'MATCH' | 'MISMATCH' | 'UNKNOWN';
    checkedAt: string;
    brokerCash: string | null;
    brokerBuyingPower: string | null;
    internalCash: string | null;
    internalEquity: string | null;
    cashDifference: string;
    sourceOfTruth: 'INTERNAL_LEDGER';
    comparedSource: 'ALPACA_PAPER_ACCOUNT';
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
type Snapshot = {
  id: string;
  cashBalance: string;
  portfolioEquity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  dailyPnl: string;
  snapshotReason: string;
  createdAt: string;
};
type ChartPoint = { label: string; value: number };

const { apiFetch } = useApi();
const message = ref('');
const busy = ref(false);
const refreshing = ref(false);
const actionError = ref('');
const { data: dashboard, error, refresh } = await useAsyncData<Dashboard>('paper-dashboard', () => apiFetch('/dashboard/paper'));
const { data: snapshots, error: snapshotsError, refresh: refreshSnapshots } = await useAsyncData<{ snapshots: Snapshot[] }>('dashboard-portfolio-snapshots', () => apiFetch('/portfolio/snapshots?limit=50'));
useAutoRefresh(refresh, 5000);
useAutoRefresh(refreshSnapshots, 5000);

const orderedSnapshots = computed(() => [...(snapshots.value?.snapshots ?? [])].reverse());
const latestSnapshot = computed(() => orderedSnapshots.value.at(-1));
const equityHistory = computed<ChartPoint[]>(() => orderedSnapshots.value.map((snapshot) => ({ label: snapshot.createdAt, value: number(snapshot.portfolioEquity) })));
const portfolioValueTrend = computed<ChartPoint[]>(() => equityHistory.value);
const pnlBars = computed(() => [
  { label: 'Realized', value: number(dashboard.value?.portfolio.realizedPnl) },
  { label: 'Unrealized', value: number(dashboard.value?.portfolio.unrealizedPnl) },
  { label: 'Daily', value: number(dashboard.value?.portfolio.dailyPnl) },
]);
const cashEquityPercent = computed(() => {
  const cash = number(dashboard.value?.portfolio.cashBalance);
  const equity = number(dashboard.value?.portfolio.portfolioEquity);
  return equity > 0 ? (cash / equity) * 100 : 0;
});
const positionCapacityPercent = computed(() => Math.min(100, ((dashboard.value?.positions.length ?? 0) / 10) * 100));
const proposalPressurePercent = computed(() => Math.min(100, ((dashboard.value?.pendingProposals.length ?? 0) / 10) * 100));
const reconciliationItems = computed(() => [
  { label: 'Status', value: dashboard.value?.reconciliation.status ?? 'UNKNOWN', className: reconciliationClass(dashboard.value?.reconciliation.status) },
  { label: 'Source of Truth', value: dashboard.value?.reconciliation.sourceOfTruth ?? '-', className: '' },
  { label: 'Alpaca Cash', value: money(dashboard.value?.reconciliation.brokerCash), className: '' },
  { label: 'Internal Cash', value: money(dashboard.value?.reconciliation.internalCash), className: '' },
  { label: 'Cash Difference', value: money(dashboard.value?.reconciliation.cashDifference), className: pnlClass(dashboard.value?.reconciliation.cashDifference) },
  { label: 'Checked', value: dateTime(dashboard.value?.reconciliation.checkedAt), className: '' },
  { label: 'Open Positions', value: String(dashboard.value?.reconciliation.openPositionCount ?? 0), className: '' },
  { label: 'Pending Paper Orders', value: String(dashboard.value?.reconciliation.pendingOrderCount ?? 0), className: '' },
]);

async function refreshDashboard() {
  refreshing.value = true;
  try {
    await Promise.all([refresh(), refreshSnapshots()]);
  } finally {
    refreshing.value = false;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Request failed. Please try again.';
}

async function approve(id: string) {
  busy.value = true;
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/approve`, { method: 'POST', body: { requestId: crypto.randomUUID() } });
    message.value = 'PAPER TRADING proposal approved.';
    await refresh();
  } catch (err) {
    actionError.value = `Approve failed: ${describeError(err)}`;
  } finally {
    busy.value = false;
  }
}

async function reject(id: string) {
  busy.value = true;
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/reject`, {
      method: 'POST',
      body: { requestId: crypto.randomUUID(), reason: 'Rejected from PAPER TRADING dashboard' },
    });
    message.value = 'PAPER TRADING proposal rejected.';
    await refresh();
  } catch (err) {
    actionError.value = `Reject failed: ${describeError(err)}`;
  } finally {
    busy.value = false;
  }
}

async function toggleKillSwitch() {
  if (!dashboard.value) return;
  busy.value = true;
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch('/settings/kill-switch', {
      method: 'PUT',
      body: { enabled: !dashboard.value.killSwitch.enabled },
    });
    message.value = 'PAPER TRADING kill switch updated.';
    await refresh();
  } catch (err) {
    actionError.value = `Kill switch update failed: ${describeError(err)}`;
  } finally {
    busy.value = false;
  }
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

function dateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

// Market data snapshots are a live pass-through from the trading engine
// (not a DB-backed entity), so they carry no assetClass field — the "/"
// in a crypto pair symbol (e.g. "BTC/USD") is a reliable display-only
// signal, distinct from the backend-verified assetClass used everywhere
// business logic depends on it (proposals/orders/positions).
function assetClassOf(symbol: string): 'STOCK' | 'CRYPTO' {
  return symbol.includes('/') ? 'CRYPTO' : 'STOCK';
}

function pnlClass(value?: string | null): string {
  return number(value) < 0 ? 'text-rose-300' : 'text-emerald-300';
}

function statusClass(value?: string): string {
  if (value === 'CONNECTED') return 'text-emerald-300';
  if (value === 'RATE_LIMITED') return 'text-amber-300';
  return 'text-rose-300';
}

function reconciliationClass(value?: string): string {
  if (value === 'MATCH') return 'text-emerald-300';
  if (value === 'MISMATCH') return 'text-rose-300';
  return 'text-amber-300';
}
</script>
