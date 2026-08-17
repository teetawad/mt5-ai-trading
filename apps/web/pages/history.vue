<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Demo results</p>
        <h1 class="page-title">History</h1>
        <p class="page-subtitle">
          Each closed or opened MT5 demo trade is explained in terms of what happened, what was planned, and which model produced the recommendation.
        </p>
      </div>
      <button class="btn-primary" :disabled="busy" @click="refreshHistory">{{ busy ? 'Refreshing...' : 'Refresh' }}</button>
    </header>

    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <section class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox label="Total Closed Trades" :value="String(statistics.totalClosedTrades ?? 0)" />
      <MetricBox label="Wins / Losses" :value="`${statistics.wins ?? 0} / ${statistics.losses ?? 0}`" />
      <MetricBox label="Win Rate" :value="percent(statistics.winRate)" />
      <MetricBox label="Total P&L" :value="money(statistics.totalPnl)" :class-name="pnlValueClass(statistics.totalPnl)" />
      <MetricBox label="Average Win" :value="money(statistics.averageWin)" class-name="text-emerald-300" />
      <MetricBox label="Average Loss" :value="money(statistics.averageLoss)" class-name="text-rose-300" />
      <MetricBox label="Best Symbol" :value="statistics.bestPerformingSymbol ?? '-'" />
      <MetricBox label="Worst Symbol" :value="statistics.worstPerformingSymbol ?? '-'" />
    </section>

    <section class="grid gap-4 lg:grid-cols-3">
      <MiniLineChart title="Equity Curve" :points="statistics.equityCurve ?? []" :value-label="money((statistics.equityCurve ?? []).at(-1)?.value)" tone="emerald" />
      <BarChart title="Symbol Performance" :data="statistics.pnlBySymbol ?? []" :formatter="money" />
      <DonutChart title="Exit Reason Breakdown" :data="statistics.exitReasons ?? []" />
    </section>

    <div class="grid gap-3 lg:grid-cols-[1fr_12rem_12rem]">
      <input v-model="search" class="field-input" placeholder="Filter by symbol">
      <select v-model="assetFilter" class="field-input">
        <option value="ALL">All asset classes</option>
        <option v-for="asset in assetClasses" :key="asset" :value="asset">{{ labelAsset(asset) }}</option>
      </select>
      <select v-model="filter" class="field-input">
        <option v-for="item in filters" :key="item" :value="item">{{ item }}</option>
      </select>
    </div>

    <div class="flex flex-wrap gap-2">
      <button
        v-for="item in filters"
        :key="item"
        class="rounded-lg border px-3 py-2 text-xs font-semibold transition"
        :class="filter === item ? 'border-sky-400/60 bg-sky-400/15 text-sky-100' : 'border-slate-700 bg-slate-950/80 text-slate-300 hover:border-sky-400/70'"
        @click="filter = item"
      >
        {{ item }}
      </button>
    </div>

    <UiCard v-if="!filteredTrades.length" title="No Demo History Yet">
      <p class="text-sm leading-6 text-slate-300">
        No matching demo trade results are stored yet. Completed trades will appear here with the AI suggestion, planned loss, final result, and exit reason.
      </p>
    </UiCard>

    <section v-else class="grid gap-4">
      <article
        v-for="trade in filteredTrades"
        :key="trade.id"
        class="rounded-lg border border-slate-800/90 bg-slate-900/75 p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)]"
      >
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p class="text-xs font-bold uppercase tracking-widest text-slate-500">{{ resultLabel(trade) }}</p>
            <h2 class="mt-1 text-2xl font-semibold text-white">{{ trade.symbol }}</h2>
            <p class="mt-2 text-sm text-slate-300">
              AI suggested {{ trade.side }}. {{ closeSentence(trade) }}
            </p>
          </div>
          <div class="text-left md:text-right">
            <p class="text-xs text-slate-500">Result</p>
            <p class="mt-1 text-3xl font-semibold" :class="pnlClass(trade)">{{ money(trade.realized_pnl) }}</p>
          </div>
        </div>

        <div class="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <InfoTile label="Opened at" help="Expected or actual demo entry price." :value="numberText(trade.actual_entry ?? trade.expected_entry)" />
          <InfoTile label="Stop Loss" help="Automatic exit to limit loss." :value="numberText(trade.stop_loss)" tone="loss" />
          <InfoTile label="Take Profit" help="Automatic exit when target profit is reached." :value="numberText(trade.take_profit)" tone="gain" />
          <InfoTile label="Planned maximum loss" help="Risk amount recorded when the trade was opened." :value="money(trade.risk_amount)" tone="loss" />
          <InfoTile label="Holding time" help="How long the demo trade stayed open." :value="holdingTime(trade)" />
        </div>

        <div class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
          <p><strong class="text-slate-100">Model:</strong> {{ trade.model_version ?? 'BASELINE_MT5_H1_V1' }}</p>
          <p class="mt-2"><strong class="text-slate-100">AI score / confidence:</strong> {{ numberText(trade.opportunity_score) }} / {{ percent(trade.confidence) }}</p>
          <p class="mt-2"><strong class="text-slate-100">Exit reason:</strong> {{ trade.exit_reason ?? 'Still open or not reconciled yet' }}</p>
          <p class="mt-2"><strong class="text-slate-100">What happened:</strong> {{ trade.beginner_note ?? closeSentence(trade) }}</p>
          <p class="mt-2"><strong class="text-slate-100">Opened:</strong> {{ formatDate(trade.opened_at) }}</p>
          <p v-if="trade.closed_at" class="mt-2"><strong class="text-slate-100">Closed:</strong> {{ formatDate(trade.closed_at) }}</p>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
type TradeRow = {
  id: string;
  symbol: string;
  asset_class?: string | null;
  side: string;
  expected_entry?: string | number | null;
  actual_entry?: string | number | null;
  stop_loss?: string | number | null;
  take_profit?: string | number | null;
  risk_amount?: string | number | null;
  realized_pnl?: string | number | null;
  exit_reason?: string | null;
  model_version?: string | null;
  opportunity_score?: string | number | null;
  confidence?: string | number | null;
  beginner_note?: string | null;
  opened_at: string;
  closed_at?: string | null;
};

const filters = ['ALL', 'WIN', 'LOSS', 'STOP LOSS', 'TAKE PROFIT', 'MANUAL'] as const;
const filter = ref<(typeof filters)[number]>('ALL');
const search = ref('');
const assetFilter = ref('ALL');
const busy = ref(false);
const errorText = ref('');
const { apiFetch } = useApi();

const { data, refresh } = await useAsyncData<{ trades: TradeRow[]; statistics: Record<string, any> }>('mt5-trade-history', () => apiFetch('/mt5/history'));
const trades = computed(() => data.value?.trades ?? []);
const statistics = computed(() => data.value?.statistics ?? {});
const assetClasses = computed(() => [...new Set(trades.value.map((trade) => trade.asset_class).filter(Boolean))] as string[]);
const filteredTrades = computed(() => trades.value.filter((trade) => {
  const term = search.value.trim().toLowerCase();
  const matchesSearch = !term || trade.symbol.toLowerCase().includes(term);
  const matchesAsset = assetFilter.value === 'ALL' || trade.asset_class === assetFilter.value;
  const matchesResult = filter.value === 'ALL'
    || (filter.value === 'WIN' && Number(trade.realized_pnl) > 0)
    || (filter.value === 'LOSS' && Number(trade.realized_pnl) < 0)
    || (filter.value === 'STOP LOSS' && trade.exit_reason === 'STOP_LOSS')
    || (filter.value === 'TAKE PROFIT' && trade.exit_reason === 'TAKE_PROFIT')
    || (filter.value === 'MANUAL' && trade.exit_reason === 'MANUAL_CLOSE');
  return matchesSearch && matchesAsset && matchesResult;
}));

async function refreshHistory() {
  busy.value = true;
  errorText.value = '';
  try {
    await refresh();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Could not refresh demo history';
  } finally {
    busy.value = false;
  }
}

function resultLabel(trade: TradeRow) {
  if (!trade.closed_at) return 'Result pending';
  const pnl = Number(trade.realized_pnl);
  if (pnl > 0) return 'Win';
  if (pnl < 0) return 'Loss';
  return 'Break even';
}

function closeSentence(trade: TradeRow) {
  if (!trade.closed_at) return 'The final result has not been reconciled yet.';
  if (trade.exit_reason === 'TAKE_PROFIT') return `Take Profit was reached after ${holdingTime(trade)}.`;
  if (trade.exit_reason === 'STOP_LOSS') return `Stop Loss was reached after ${holdingTime(trade)}.`;
  if (trade.exit_reason === 'MANUAL_CLOSE') return `The trade was closed manually after ${holdingTime(trade)}.`;
  return `The trade closed after ${holdingTime(trade)}.`;
}

function pnlClass(trade: TradeRow) {
  return pnlValueClass(trade.realized_pnl);
}

function pnlValueClass(value: unknown) {
  const pnl = Number(value);
  if (pnl > 0) return 'text-emerald-300';
  if (pnl < 0) return 'text-rose-300';
  return 'text-slate-200';
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

function holdingTime(trade: TradeRow) {
  if (!trade.closed_at) return 'Still open';
  const opened = new Date(trade.opened_at).getTime();
  const closed = new Date(trade.closed_at).getTime();
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return '-';
  const minutes = Math.max(0, Math.floor((closed - opened) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest}m` : `${rest}m`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function percent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '-';
}

function labelAsset(value: string) {
  return value.replace('_CFD', '').replace('_', ' ');
}
</script>
