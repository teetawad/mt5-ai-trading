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

    <UiCard v-if="!positions.length" title="No Open Demo Trades">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p class="text-sm leading-6 text-slate-300">
          No demo trades are open right now. Ask AI to scan your watchlist when you want to review a new opportunity.
        </p>
        <NuxtLink to="/analysis" class="btn-primary">Run AI Analysis</NuxtLink>
      </div>
    </UiCard>

    <section v-else class="grid gap-4">
      <article
        v-for="position in positions"
        :key="position.ticket ?? `${position.symbol}-${position.time}`"
        class="rounded-lg border border-slate-800/90 bg-slate-900/75 p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)]"
      >
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p class="text-xs font-bold uppercase tracking-widest text-slate-500">Status: open</p>
            <h2 class="mt-1 text-2xl font-semibold text-white">{{ position.symbol }} - {{ sideLabel(position) }}</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <StatusPill label="OPEN" />
              <StatusPill :label="sideLabel(position)" />
              <StatusPill label="DEMO" />
            </div>
          </div>
          <div class="text-left md:text-right">
            <p class="text-xs text-slate-500">Current result</p>
            <p class="mt-1 text-3xl font-semibold" :class="profitClass(position)">
              {{ money(position.profit) }}
            </p>
          </div>
        </div>

        <div class="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <InfoTile label="Entered at" help="The price where this demo trade opened." :value="numberText(position.price_open)" />
          <InfoTile label="Current" help="Latest MT5 price for this open demo trade." :value="numberText(position.price_current)" />
          <InfoTile label="Stop Loss" help="Automatic exit to limit loss." :value="numberText(position.sl)" tone="loss" />
          <InfoTile label="Take Profit" help="Automatic exit when target profit is reached." :value="numberText(position.tp)" tone="gain" />
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
      </article>
    </section>
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
};

const { apiFetch } = useApi();
const busy = ref(false);
const errorText = ref('');

const { data, refresh } = await useAsyncData<{ positions: PositionRow[] }>('mt5-open-positions', () => apiFetch('/mt5/positions'));
useAutoRefresh(refresh, 5000);

const positions = computed(() => data.value?.positions ?? []);
const totalFloatingPnl = computed(() => positions.value.reduce((sum, position) => sum + numeric(position.profit), 0));
const totalRiskExposed = computed(() => positions.value.reduce((sum, position) => sum + estimatedRisk(position), 0));

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
