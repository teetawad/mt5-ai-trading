<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">MT5 demo control center</p>
        <h1 class="page-title">Home Dashboard</h1>
        <p class="page-subtitle">
          One beginner-friendly view for demo money, open trades, AI readiness, market status, and performance.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-primary" :disabled="busy" @click="refreshAll">{{ busy ? 'Refreshing...' : 'Refresh' }}</button>
        <NuxtLink to="/ai-trade" class="btn-success">Ask AI</NuxtLink>
      </div>
    </header>

    <div v-if="errorText" class="notice-error">{{ errorText }}</div>
    <div v-if="message" class="notice-info">{{ message }}</div>
    <div v-if="dashboard?.status.blocked_reason" class="notice-warn">
      Demo safety status: {{ dashboard.status.blocked_reason }}
    </div>

    <section class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox label="Current Demo Balance" :value="money(account.balance)" />
      <MetricBox label="Equity" :value="money(account.equity)" />
      <MetricBox label="Money Remaining" :value="money(account.freeMargin)" />
      <MetricBox label="Money Used" :value="money(account.usedMargin)" />
      <MetricBox label="Realized P&L" :value="money(account.realizedPnl)" :class-name="pnlClass(account.realizedPnl)" />
      <MetricBox label="Unrealized P&L" :value="money(account.unrealizedPnl)" :class-name="pnlClass(account.unrealizedPnl)" />
      <MetricBox label="Today P&L" :value="money(account.todayPnl)" :class-name="pnlClass(account.todayPnl)" />
      <MetricBox label="Open Trades" :value="String(stats.openTrades)" />
    </section>

    <section class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox label="Win Rate" :value="percent(stats.winRate)" />
      <MetricBox label="Closed Trades" :value="String(stats.totalClosedTrades)" />
      <MetricBox label="Wins / Losses" :value="`${stats.totalWins} / ${stats.totalLosses}`" />
      <MetricBox label="Markets Open Now" :value="`${marketSummary.open ?? 0} / ${marketSummary.total ?? 0}`" :class-name="Number(marketSummary.open ?? 0) > 0 ? 'text-emerald-300' : 'text-amber-200'" />
    </section>

    <section class="grid gap-4 lg:grid-cols-[1fr_0.85fr]">
      <UiCard title="AI Ready Summary" subtitle="Server-side demo and risk protections remain active.">
        <div class="grid gap-3 md:grid-cols-3">
          <InfoTile label="MT5 Demo" :value="demoReady ? 'READY' : 'NOT READY'" :tone="demoReady ? 'gain' : 'loss'" />
          <InfoTile label="AI Scan" :value="dashboard?.aiReady ? 'READY' : 'WAITING'" />
          <InfoTile label="Next Market" :value="nextMarketLabel" />
        </div>
        <div class="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-sm leading-6 text-slate-300">
          Beginner workflow: choose markets to watch, run AI analysis, review entry/SL/TP/size, then check Open Trades and History.
        </div>
      </UiCard>

      <UiCard title="AI Top Opportunities" subtitle="Ranked by Trade Score — most recent AI analysis per watched symbol. Does not place any trade automatically.">
        <div v-if="aiTopOpportunities.length" class="space-y-3">
          <NuxtLink
            v-for="row in aiTopOpportunities"
            :key="row.symbol"
            to="/ai-trade"
            class="block rounded-lg border border-slate-800 bg-slate-950/70 p-4 transition hover:border-sky-400/60"
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="font-semibold text-white">{{ row.symbol }}</p>
                <p class="mt-1 text-xs text-slate-400">{{ labelAsset(row.assetClass) }}</p>
              </div>
              <div class="flex flex-col items-end gap-1">
                <StatusPill :label="row.decision" />
                <StatusPill v-if="row.action" :label="row.action" />
              </div>
            </div>
            <div class="mt-3 flex items-baseline gap-2">
              <p v-if="row.tradeabilityPct !== null" class="text-2xl font-bold" :class="scoreClass(row.tradeabilityPct)">{{ Math.round(row.tradeabilityPct) }}%</p>
              <p v-if="row.tradeabilityRatingLabelTh" class="text-xs text-slate-400">{{ row.tradeabilityRatingLabelTh }}</p>
            </div>
          </NuxtLink>
        </div>
        <EmptyState
          v-else-if="aiOpportunitiesError"
          title="AI opportunities are temporarily unavailable"
          :message="aiOpportunitiesErrorMessage"
        />
        <EmptyState v-else title="No AI opportunities yet" message="Run FIND BEST TRADES on the AI Trade page to see ranked ideas here." />
      </UiCard>
    </section>

    <section class="grid gap-4 lg:grid-cols-3">
      <MiniLineChart title="Equity Curve / Cumulative P&L" :points="equityCurve" :value-label="money(lastEquityPoint)" tone="emerald" />
      <BarChart title="Daily / Symbol P&L" :data="symbolPnl" :formatter="money" />
      <DonutChart title="Win / Loss Summary" :data="winLossChart" />
    </section>

    <UiCard title="Portfolio by Symbol" subtitle="Open demo exposure grouped by MT5 symbol.">
      <div v-if="portfolio.length" class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="item in portfolio" :key="item.symbol" class="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <div class="flex items-center justify-between gap-3">
            <p class="font-semibold text-white">{{ item.symbol }}</p>
            <span class="text-xs text-slate-400">{{ item.positions }} open</span>
          </div>
          <p class="mt-2 text-sm text-slate-300">Volume {{ numberText(item.volume) }}</p>
          <p class="mt-1 text-sm" :class="pnlClass(item.unrealizedPnl)">Floating P&L {{ money(item.unrealizedPnl) }}</p>
        </div>
      </div>
      <EmptyState v-else title="No open portfolio" message="Open demo trades will appear here grouped by symbol." />
    </UiCard>

    <UiCard title="Choose Markets for AI to Watch" subtitle="Only synced MT5 demo broker instruments are shown.">
      <div class="grid gap-3 lg:grid-cols-[1fr_12rem]">
        <input v-model="search" class="field-input" placeholder="Search symbols, e.g. EURUSD, XAUUSD, BTC">
        <select v-model="assetFilter" class="field-input">
          <option v-for="asset in availableAssets" :key="asset" :value="asset">{{ asset === 'ALL' ? 'All asset classes' : labelAsset(asset) }}</option>
        </select>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button class="btn-success" :disabled="busy" @click="syncInstruments">Sync Instruments</button>
        <NuxtLink to="/advanced/scanner" class="btn-primary">Advanced Symbol Manager</NuxtLink>
      </div>
      <div v-if="filteredInstruments.length" class="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="instrument in filteredInstruments.slice(0, 24)"
          :key="instrument.symbol"
          class="rounded-lg border px-3 py-3 text-left text-sm font-semibold transition"
          :class="instrument.watchlist_enabled ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100' : 'border-slate-700 bg-slate-950/80 text-slate-200 hover:border-sky-400/70'"
          :disabled="busy"
          @click="setWatchlist([instrument.symbol], !instrument.watchlist_enabled)"
        >
          {{ instrument.watchlist_enabled ? 'Watching' : 'Watch' }} {{ instrument.symbol }}
          <span class="block text-xs font-normal text-slate-400">{{ labelAsset(instrument.asset_class) }}</span>
        </button>
      </div>
      <EmptyState v-else title="No synced symbols" message="Sync instruments from MT5, then choose what AI should watch." />
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type InstrumentRow = { symbol: string; asset_class: string; description?: string | null; watchlist_enabled: boolean };
type AiOpportunityRow = { symbol: string; assetClass: string; decision: string; action: string | null; confidencePct: number | null; tradeabilityPct: number | null; tradeabilityRating: string | null; tradeabilityRatingLabelTh: string | null };

const { apiFetch } = useApi();
const busy = ref(false);
const message = ref('');
const errorText = ref('');
const search = ref('');
const assetFilter = ref('ALL');

const { data: dashboard, refresh: refreshDashboard } = await useAsyncData<Record<string, any>>('mt5-dashboard', () => apiFetch('/mt5/dashboard'), { lazy: true });
const { data: instrumentData, refresh: refreshInstruments } = await useAsyncData<{ instruments: InstrumentRow[] }>('dashboard-instruments', () => apiFetch('/mt5/instruments'), { lazy: true });
const { data: aiOpportunities, error: aiOpportunitiesError, refresh: refreshAiOpportunities } = await useAsyncData<{ opportunities: AiOpportunityRow[] }>('dashboard-ai-opportunities', () => apiFetch('/mt5/ai-trade/top-opportunities'), { lazy: true });
useAutoRefresh(refreshDashboard, 7000);

const account = computed(() => dashboard.value?.account ?? {});
const stats = computed(() => dashboard.value?.statistics ?? { openTrades: 0, winRate: 0, totalClosedTrades: 0, totalWins: 0, totalLosses: 0 });
const marketSummary = computed(() => dashboard.value?.marketSummary ?? {});
const aiTopOpportunities = computed<AiOpportunityRow[]>(() => aiOpportunities.value?.opportunities ?? []);
// AI Top Opportunities degrades gracefully (spec: Home must never throw
// during setup just because this one widget's upstream is temporarily
// down) — a fetch failure here shows its own "temporarily unavailable"
// message instead of the misleading generic "no opportunities yet" empty
// state, using only the already-normalized, plain-language ApiError.message
// (useApi.ts's apiFetch never throws a raw Error/Response/FetchError).
const aiOpportunitiesErrorMessage = computed(() => {
  const err = aiOpportunitiesError.value as { message?: string } | null;
  return err?.message || 'AI opportunities are temporarily unavailable. Please try again shortly.';
});
const portfolio = computed(() => dashboard.value?.portfolioBySymbol ?? []);
const demoReady = computed(() => Boolean(dashboard.value?.status?.connected && dashboard.value?.status?.demo_verified));
const nextMarketLabel = computed(() => marketSummary.value.nextMarketOpenSymbol ? `${marketSummary.value.nextMarketOpenSymbol} ${formatDate(marketSummary.value.nextMarketOpen)}` : 'Not available');
const equityCurve = computed(() => dashboard.value?.charts?.equityCurve ?? []);
const lastEquityPoint = computed(() => equityCurve.value.at(-1)?.value ?? 0);
const symbolPnl = computed(() => dashboard.value?.charts?.pnlBySymbol ?? []);
const winLossChart = computed(() => [
  { label: 'Wins', value: stats.value.totalWins },
  { label: 'Losses', value: stats.value.totalLosses },
].filter((item) => item.value > 0));
const instruments = computed(() => instrumentData.value?.instruments ?? []);
const availableAssets = computed(() => ['ALL', ...new Set(instruments.value.map((instrument) => instrument.asset_class).filter(Boolean))]);
const filteredInstruments = computed(() => {
  const term = search.value.trim().toLowerCase();
  return instruments.value.filter((instrument) => {
    const matchesSearch = !term || instrument.symbol.toLowerCase().includes(term) || (instrument.description ?? '').toLowerCase().includes(term);
    const matchesAsset = assetFilter.value === 'ALL' || instrument.asset_class === assetFilter.value;
    return matchesSearch && matchesAsset;
  });
});

async function refreshAll() {
  busy.value = true;
  errorText.value = '';
  try {
    await Promise.all([refreshDashboard(), refreshInstruments(), refreshAiOpportunities()]);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Refresh failed';
  } finally {
    busy.value = false;
  }
}

async function syncInstruments() {
  busy.value = true;
  errorText.value = '';
  message.value = '';
  try {
    const result = await apiFetch<{ imported: number }>('/mt5/sync-instruments', { method: 'POST' });
    message.value = `Synced ${result.imported} demo broker instruments.`;
    await refreshInstruments();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Instrument sync failed';
  } finally {
    busy.value = false;
  }
}

async function setWatchlist(symbols: string[], enabled: boolean) {
  busy.value = true;
  errorText.value = '';
  message.value = '';
  try {
    await apiFetch('/mt5/watchlist', { method: 'PATCH', body: { symbols, enabled } });
    message.value = `${enabled ? 'Enabled' : 'Disabled'} ${symbols.join(', ')} for AI scans.`;
    await Promise.all([refreshDashboard(), refreshInstruments()]);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Watchlist update failed';
  } finally {
    busy.value = false;
  }
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$-';
  return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function percent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '-';
}

function pnlClass(value: unknown) {
  const number = Number(value);
  if (number > 0) return 'text-emerald-300';
  if (number < 0) return 'text-rose-300';
  return 'text-slate-200';
}

function numberText(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '-';
}

function formatDate(value: unknown) {
  if (!value) return '-';
  return new Date(String(value)).toLocaleString();
}

function labelAsset(value: string) {
  return value.replace('_CFD', '').replace('_', ' ');
}

function scoreClass(score: number) {
  if (score >= 75) return 'text-emerald-300';
  if (score >= 60) return 'text-sky-300';
  if (score >= 40) return 'text-amber-300';
  return 'text-rose-300';
}
</script>
