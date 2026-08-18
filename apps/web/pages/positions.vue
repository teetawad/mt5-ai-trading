<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Open demo trades</p>
        <h1 class="page-title">Open Trades</h1>
        <p class="page-subtitle">
          Live MT5 demo positions with plain-language progress toward automatic loss protection and profit targets.
        </p>
      </div>
      <button class="btn-primary" :disabled="busy" @click="refreshPositions">{{ busy ? 'Refreshing...' : 'Refresh' }}</button>
    </header>

    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <section class="grid gap-3 md:grid-cols-3">
      <MetricBox label="Total Open Trades" :value="String(positions.length)" />
      <MetricBox label="Total Floating P&L" :value="money(totalFloatingPnl)" :class-name="profitValueClass(totalFloatingPnl)" />
      <MetricBox label="Total Risk Exposed" :value="money(totalRiskExposed)" class-name="text-rose-200" />
    </section>

    <UiCard title="Pending Orders" subtitle="Real MT5 pending orders (BUY_LIMIT / SELL_LIMIT / BUY_STOP / SELL_STOP) waiting for price. The broker holds these — the browser does not need to stay open.">
      <div v-if="pendingOrders.length" class="grid gap-3 md:grid-cols-2">
        <div v-for="order in pendingOrders" :key="String(order.ticket)" class="rounded-lg border border-sky-400/30 bg-sky-400/5 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="font-semibold text-white">{{ order.symbol }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ pendingTypeLabel(order) }}</p>
            </div>
            <StatusPill label="PENDING" />
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
            <span>Entry: {{ numberText(order.price_open) }}</span>
            <span>Volume: {{ numberText(order.volume) }}</span>
            <span>SL: {{ numberText(order.sl) }}</span>
            <span>TP: {{ numberText(order.tp) }}</span>
            <span>Expiration: {{ expirationText(order) }}</span>
            <span>Ticket: {{ order.ticket }}</span>
            <span v-if="order.ai_trade_plan">AI Confidence: {{ Math.round(Number(order.ai_trade_plan.confidence ?? 0)) }}%</span>
          </div>
          <button
            class="btn-danger mt-3"
            :disabled="cancellingTicket === String(order.ticket)"
            @click="cancelPendingOrder(order)"
          >
            {{ cancellingTicket === String(order.ticket) ? 'Cancelling...' : 'Cancel Pending Demo Order' }}
          </button>
        </div>
      </div>
      <EmptyState v-else title="No pending demo orders" message="Pending orders created from AI Trade plans (PULLBACK/BREAKOUT) will appear here." />
    </UiCard>

    <UiCard v-if="!positions.length" title="No Open Demo Trades">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p class="text-sm leading-6 text-slate-300">
          No demo trades are open right now. Ask AI to analyze a symbol when you want to review a new opportunity.
        </p>
        <NuxtLink to="/ai-trade" class="btn-primary">Ask AI</NuxtLink>
      </div>
    </UiCard>

    <section v-else class="grid gap-4">
      <article
        v-for="position in positions"
        :key="position.ticket ?? `${position.symbol}-${position.time}`"
        class="rounded-lg border p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)] transition"
        :class="isHighlighted(position) ? 'border-emerald-400 bg-emerald-400/5 ring-2 ring-emerald-400/50' : 'border-slate-800/90 bg-slate-900/75'"
      >
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p
              v-if="isHighlighted(position)"
              class="mb-1 text-xs font-bold uppercase tracking-widest text-emerald-300"
            >
              Just opened
            </p>
            <p class="text-xs font-bold uppercase tracking-widest text-slate-500">Status: open</p>
            <h2 class="mt-1 text-2xl font-semibold text-white">{{ position.symbol }} - {{ sideLabel(position) }}</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <StatusPill label="MT5 CONFIRMED" />
              <StatusPill :label="sideLabel(position)" />
              <StatusPill label="DEMO" />
            </div>
            <p class="mt-2 text-xs text-slate-500">MT5 Ticket: {{ position.ticket ?? '-' }}</p>
          </div>
          <div class="text-left md:text-right">
            <p class="text-xs text-slate-500">Floating P&L</p>
            <p class="mt-1 text-3xl font-semibold" :class="profitClass(position)">
              {{ money(position.profit) }}
            </p>
          </div>
        </div>

        <div class="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <InfoTile label="Actual entry" help="The real MT5 execution price for this demo trade." :value="numberText(position.price_open)" />
          <InfoTile label="Current price" help="Latest MT5 price for this open demo trade." :value="numberText(position.price_current)" />
          <InfoTile label="Stop Loss" help="Automatic exit to limit loss." :value="numberText(position.sl)" tone="loss" />
          <InfoTile label="Take Profit" help="Automatic exit when target profit is reached." :value="numberText(position.tp)" tone="gain" />
          <InfoTile label="Opened time" help="When MT5 confirmed this demo position." :value="openedAtText(position)" />
          <InfoTile label="Holding time" help="How long this demo trade has been open." :value="holdingTime(position)" />
        </div>

        <div class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <div class="mb-2 flex justify-between text-xs text-slate-500">
            <span>Stop Loss</span>
            <span>Entry</span>
            <span>Current</span>
            <span>Take Profit</span>
          </div>
          <div class="relative h-3 rounded-full bg-slate-800">
            <div class="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500/70 via-sky-400/70 to-emerald-400/70" :style="{ width: progressWidth(position) }" />
          </div>
          <p class="mt-3 text-xs leading-5 text-slate-400">
            Automatic loss protection is the Stop Loss. Automatic profit target is the Take Profit. The browser does not need to stay open for broker-side SL/TP where MT5 supports it.
          </p>
        </div>

        <div class="mt-4 grid gap-3 md:grid-cols-3">
          <InfoTile label="Lot size / size used" help="The MT5 demo position volume." :value="numberText(position.volume)" />
          <InfoTile label="Margin used" help="Margin reported by MT5 if available." :value="money(position.margin)" />
          <InfoTile label="AI plan alignment" help="Live alignment needs the latest saved AI plan." value="MONITORED" />
        </div>

        <div v-if="position.entry_plan_id" class="mt-4 grid gap-3 md:grid-cols-4">
          <InfoTile label="Planned entry" help="The AI's original planned entry price for this trade." :value="numberText(position.planned_entry)" />
          <InfoTile label="Actual entry" help="The real MT5 execution price recorded by the EntryPlanWatcher." :value="numberText(position.actual_entry)" />
          <InfoTile label="AI model / version" help="The model that produced this trade's entry plan." :value="String(position.model_version ?? '-')" />
          <InfoTile label="Source entry plan" help="The mt5_entry_plans row that the EntryPlanWatcher executed." :value="String(position.entry_plan_id).slice(0, 8)" />
        </div>
      </article>
    </section>

    <UiCard title="Developer: Send MT5 Demo Test Order" subtitle="DEMO ONLY. Verifies the execution pipe (order_check -> order_send -> positions_get confirmation) independently of AI strategy. Uses the smallest broker-allowed lot size with a safe Stop Loss/Take Profit.">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label class="text-xs font-semibold uppercase tracking-wide text-slate-500">Symbol</label>
          <input v-model="testOrderSymbol" class="field-input" placeholder="e.g. EURUSD">
        </div>
        <div>
          <label class="text-xs font-semibold uppercase tracking-wide text-slate-500">Side</label>
          <select v-model="testOrderSide" class="field-input">
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>
        <button class="btn-danger" :disabled="testOrderBusy || !testOrderSymbol" @click="sendTestOrder">
          {{ testOrderBusy ? 'Sending DEMO order...' : 'Send MT5 Demo Test Order' }}
        </button>
      </div>
      <p v-if="testOrderResult" class="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm leading-6 text-emerald-100">
        MT5 CONFIRMED — {{ testOrderResult.symbol }} {{ testOrderResult.side }}, ticket {{ testOrderResult.orderTicket ?? testOrderResult.dealTicket }},
        volume {{ testOrderResult.volume }}, entry {{ testOrderResult.actualEntry }}, SL {{ testOrderResult.stopLoss }}, TP {{ testOrderResult.takeProfit }}.
        Check MT5 Toolbox -> Trade and refresh Open Trades above.
      </p>
      <p v-if="testOrderError" class="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-sm leading-6 text-rose-100">{{ testOrderError }}</p>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type PositionRow = {
  ticket?: number | string;
  symbol?: string;
  type?: number | string;
  volume?: number | string;
  price_open?: number | string;
  price_current?: number | string;
  sl?: number | string;
  tp?: number | string;
  profit?: number | string;
  margin?: number | string;
  time?: number | string;
  time_msc?: number | string;
  entry_plan_id?: string | null;
  model_version?: string | null;
  planned_entry?: number | string | null;
  actual_entry?: number | string | null;
};

type DemoTestOrderResult = {
  symbol: string;
  side: string;
  volume: number;
  actualEntry: number;
  stopLoss: number;
  takeProfit: number;
  orderTicket: string | null;
  dealTicket: string | null;
};

const { apiFetch } = useApi();
const busy = ref(false);
const errorText = ref('');
const testOrderSymbol = ref('');
const testOrderSide = ref<'BUY' | 'SELL'>('BUY');
const testOrderBusy = ref(false);
const testOrderResult = ref<DemoTestOrderResult | null>(null);
const testOrderError = ref('');

type PendingOrderRow = {
  ticket?: number | string;
  symbol?: string;
  type?: number | string;
  price_open?: number | string;
  volume?: number | string;
  sl?: number | string;
  tp?: number | string;
  time_expiration?: number | string;
  time_setup?: number | string;
  ai_trade_plan?: { id?: string; confidence?: number | string } | null;
};

const { data, refresh } = await useAsyncData<{ positions: PositionRow[] }>('mt5-open-positions', () => apiFetch('/mt5/positions'), { lazy: true });
const { data: pendingData, refresh: refreshPending } = await useAsyncData<{ orders: PendingOrderRow[] }>('mt5-pending-orders', () => apiFetch('/mt5/ai-trade/pending-orders'), { lazy: true });
const pendingOrders = computed(() => pendingData.value?.orders ?? []);
const cancellingTicket = ref<string | null>(null);
useAutoRefresh(refresh, 5000);
useAutoRefresh(refreshPending, 5000);

// This page's whole purpose is live MT5 positions - after a fresh
// execution (e.g. arriving via "View Open Trade" with ?ticket=...), any
// cached data from before that trade must never be shown, even briefly.
// A background poll would eventually catch up, but "immediately" means
// immediately, so force a fresh fetch on every mount.
onMounted(() => { void refresh(); });

const route = useRoute();
const highlightTicket = computed(() => {
  const raw = route.query.ticket;
  return typeof raw === 'string' && raw ? raw : null;
});

const positions = computed(() => data.value?.positions ?? []);
const totalFloatingPnl = computed(() => positions.value.reduce((sum, position) => sum + numeric(position.profit), 0));
const totalRiskExposed = computed(() => positions.value.reduce((sum, position) => sum + estimatedRisk(position), 0));

function isHighlighted(position: PositionRow) {
  return highlightTicket.value !== null && String(position.ticket ?? '') === highlightTicket.value;
}

async function refreshPositions() {
  busy.value = true;
  errorText.value = '';
  try {
    await refresh();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Could not refresh open demo trades';
  } finally {
    busy.value = false;
  }
}

async function sendTestOrder() {
  if (!testOrderSymbol.value) return;
  testOrderBusy.value = true;
  testOrderError.value = '';
  testOrderResult.value = null;
  try {
    testOrderResult.value = await apiFetch<DemoTestOrderResult>('/mt5/demo-test-order', {
      method: 'POST',
      body: { symbol: testOrderSymbol.value.trim().toUpperCase(), side: testOrderSide.value },
    });
    await refresh();
  } catch (error) {
    testOrderError.value = error instanceof Error ? error.message : 'DEMO test order was blocked';
  } finally {
    testOrderBusy.value = false;
  }
}

function pendingTypeLabel(order: PendingOrderRow) {
  const map: Record<string, string> = { '2': 'BUY LIMIT', '3': 'SELL LIMIT', '4': 'BUY STOP', '5': 'SELL STOP' };
  return map[String(order.type)] ?? String(order.type ?? 'PENDING');
}

function expirationText(order: PendingOrderRow) {
  const seconds = Number(order.time_expiration);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'GTC';
  return new Date(seconds * 1000).toLocaleString();
}

async function cancelPendingOrder(order: PendingOrderRow) {
  const planId = order.ai_trade_plan?.id;
  if (!planId) return;
  cancellingTicket.value = String(order.ticket);
  try {
    await apiFetch(`/mt5/ai-trade/plans/${planId}/cancel`, { method: 'POST' });
    await refreshPending();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Could not cancel the pending demo order';
  } finally {
    cancellingTicket.value = null;
  }
}

function sideLabel(position: PositionRow) {
  if (position.type === 0 || position.type === '0' || String(position.type).toUpperCase() === 'BUY') return 'BUY';
  if (position.type === 1 || position.type === '1' || String(position.type).toUpperCase() === 'SELL') return 'SELL';
  return String(position.type ?? 'TRADE').toUpperCase();
}

function profitClass(position: PositionRow) {
  return profitValueClass(position.profit);
}

function profitValueClass(value: unknown) {
  const number = Number(value);
  if (number > 0) return 'text-emerald-300';
  if (number < 0) return 'text-rose-300';
  return 'text-slate-200';
}

function numeric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function estimatedRisk(position: PositionRow) {
  const open = numeric(position.price_open);
  const sl = numeric(position.sl);
  const volume = numeric(position.volume) || 1;
  if (!open || !sl) return 0;
  return Math.abs(open - sl) * volume;
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$-';
  return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function numberText(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '-';
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function openedAtText(position: PositionRow) {
  const openedMs = Number(position.time_msc ?? 0) > 0
    ? Number(position.time_msc)
    : Number(position.time ?? 0) * 1000;
  if (!Number.isFinite(openedMs) || openedMs <= 0) return '-';
  return new Date(openedMs).toLocaleString();
}

function holdingTime(position: PositionRow) {
  const opened = Number(position.time_msc ?? 0) > 0
    ? Number(position.time_msc)
    : Number(position.time ?? 0) * 1000;
  if (!Number.isFinite(opened) || opened <= 0) return '-';
  const minutes = Math.max(0, Math.floor((Date.now() - opened) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest}m` : `${rest}m`;
}

function progressWidth(position: PositionRow) {
  const sl = Number(position.sl);
  const tp = Number(position.tp);
  const current = Number(position.price_current);
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || !Number.isFinite(current) || sl === tp) return '50%';
  const low = Math.min(sl, tp);
  const high = Math.max(sl, tp);
  const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
  return `${pct}%`;
}
</script>
