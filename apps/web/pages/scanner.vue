<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">MT5 Watchlist Scanner</p>
        <h1 class="page-title">Scanner</h1>
        <p class="page-subtitle">
          Manage synced MT5 broker instruments, enable the owner watchlist, and run H1 baseline analysis for enabled symbols only.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-primary" :disabled="busy" @click="refreshAll">Refresh</button>
        <button class="btn-success" :disabled="busy" @click="syncInstruments">Sync Instruments</button>
        <button class="btn-success" :disabled="busy || enabledCount === 0" @click="runScanNow">Run Scan Now</button>
      </div>
    </header>

    <div v-if="message" class="notice-info">{{ message }}</div>
    <div v-if="errorText" class="notice-error">{{ errorText }}</div>
    <div v-if="scanner?.status.blocked_reason" class="notice-warn">
      {{ scanner.status.blocked_reason }}
    </div>

    <section class="grid gap-4 md:grid-cols-4">
      <MetricBox
        label="MT5 Connection"
        :value="scanner?.status.connected ? 'CONNECTED' : 'DISCONNECTED'"
        :class-name="scanner?.status.connected ? 'text-emerald-300' : 'text-rose-300'"
      />
      <MetricBox
        label="Demo Guard"
        :value="scanner?.status.demo_verified ? 'DEMO VERIFIED' : 'BLOCKED'"
        :class-name="scanner?.status.demo_verified ? 'text-emerald-300' : 'text-rose-300'"
      />
      <MetricBox label="Synced Instruments" :value="String(instruments.length)" />
      <MetricBox label="Enabled Watchlist" :value="String(enabledCount)" />
    </section>

    <UiCard
      title="Enabled Watchlist"
      subtitle="Only these instruments are analyzed by the scanner."
    >
      <div v-if="enabledInstruments.length" class="flex flex-wrap gap-2">
        <span
          v-for="instrument in enabledInstruments"
          :key="instrument.symbol"
          class="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-100"
        >
          {{ instrument.symbol }}
          <span class="ml-2 font-normal text-emerald-200/80">{{ labelAsset(instrument.asset_class) }}</span>
        </span>
      </div>
      <div v-else class="text-sm text-slate-400">
        No enabled instruments yet. Enable broker symbols in Instrument Management below.
      </div>
    </UiCard>

    <UiCard
      ref="scanResultsCard"
      title="Scan Results"
      subtitle="H1 analysis results for enabled watchlist instruments only."
      body-class="p-0"
    >
      <div class="flex flex-wrap gap-2 border-b border-slate-800/80 p-4">
        <button
          v-for="filter in scanFilters"
          :key="filter.value"
          class="rounded-lg border px-3 py-2 text-xs font-semibold transition"
          :class="scanFilter === filter.value ? 'border-sky-400/60 bg-sky-400/15 text-sky-100' : 'border-slate-700 bg-slate-950/80 text-slate-300 hover:border-sky-400/70'"
          @click="scanFilter = filter.value"
        >
          {{ filter.label }}
        </button>
      </div>
      <DataTable
        :columns="['Symbol','Asset Class','Market Status','Session Open','Session Close','Next Open','Server Time','Local Time','Data Freshness','Bid','Ask','Spread','Decision','Entry Plan','Entry Status','Trigger/Zone','Confidence','Score','Entry','SL','TP','R:R','Risk Engine','Last H1 Candle']"
        :empty="filteredScannerRows.length === 0"
        empty-label="No scanner rows. Enable watchlist instruments, then run a scan."
      >
        <tr
          v-for="row in filteredScannerRows"
          :key="row.symbol"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="whitespace-nowrap px-4 py-3 font-semibold text-white">{{ row.symbol }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ labelAsset(row.assetClass) }}</td>
          <td class="whitespace-nowrap px-4 py-3 font-semibold" :class="marketClass(row)">
            {{ marketLabel(row) }}
          </td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.session_open) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.session_close) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.next_session_open) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.server_time) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.local_time) }}</td>
          <td class="whitespace-nowrap px-4 py-3" :class="row.data_status === 'LIVE' ? 'text-emerald-300' : 'text-amber-200'">
            {{ row.data_status || row.freshness || 'UNKNOWN' }}
          </td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.bid || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.ask || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.spread || row.features?.spread || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 font-semibold" :class="decisionClass(row.decision)">
            {{ displayDecision(row) }}
          </td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.entry_plan?.entry_strategy || row.entry_strategy || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.entry_plan?.current_entry_status || row.current_entry_status || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ entryTrigger(row) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ pct(row.confidence) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.opportunity_score }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.reference_entry || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.stop_loss || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.take_profit || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ row.risk_reward || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 font-semibold" :class="row.risk?.result === 'PASS' ? 'text-emerald-300' : 'text-amber-200'">
            {{ riskLabel(row) }}
          </td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatDate(row.signal_candle_timestamp) }}</td>
        </tr>
      </DataTable>
    </UiCard>

    <UiCard
      title="Instrument Management"
      subtitle="Search all synced MT5 instruments and persist owner watchlist changes in PostgreSQL."
    >
      <div class="grid gap-3 lg:grid-cols-[1fr_12rem_12rem]">
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-slate-400">Search</span>
          <input
            v-model="search"
            class="field-input"
            placeholder="Symbol or description"
          >
        </label>
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-slate-400">Asset Class</span>
          <select v-model="assetFilter" class="field-input">
            <option value="ALL">All</option>
            <option value="FOREX">Forex</option>
            <option value="METAL">Metals</option>
            <option value="INDEX_CFD">Indices</option>
            <option value="COMMODITY_CFD">Commodities</option>
            <option value="CRYPTO_CFD">Crypto/CFD</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</span>
          <select v-model="enabledFilter" class="field-input">
            <option value="ALL">All</option>
            <option value="ENABLED">Enabled</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </label>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button class="btn-success" :disabled="busy || selectedSymbols.length === 0" @click="setSelected(true)">Enable selected</button>
        <button class="btn-danger" :disabled="busy || selectedSymbols.length === 0" @click="setSelected(false)">Disable selected</button>
        <span class="text-xs text-slate-400">{{ selectedSymbols.length }} selected</span>
      </div>

      <div v-if="suggested.length" class="mt-4 flex flex-wrap gap-2">
        <button
          v-for="instrument in suggested"
          :key="instrument.symbol"
          class="rounded-lg border px-3 py-2 text-xs font-semibold transition"
          :class="instrument.watchlist_enabled ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100' : 'border-slate-700 bg-slate-950/80 text-slate-200 hover:border-sky-400/70'"
          :disabled="busy"
          @click="setSymbols([instrument.symbol], !instrument.watchlist_enabled)"
        >
          {{ instrument.watchlist_enabled ? 'Disable' : 'Enable' }} {{ instrument.symbol }}
        </button>
      </div>
    </UiCard>

    <UiCard title="Synced Instruments" subtitle="All instruments imported from the connected MT5 broker." body-class="p-0">
      <DataTable
        :columns="['Select','Symbol','Asset Class','Description','Base','Profit','Point','Volume','Watchlist']"
        :empty="filteredInstruments.length === 0"
        empty-label="No synced instruments match the current filters."
      >
        <tr
          v-for="instrument in filteredInstruments"
          :key="instrument.symbol"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3">
            <input
              :checked="selected.has(instrument.symbol)"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400"
              @change="toggleSelected(instrument.symbol)"
            >
          </td>
          <td class="whitespace-nowrap px-4 py-3 font-semibold text-slate-100">{{ instrument.symbol }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ labelAsset(instrument.asset_class) }}</td>
          <td class="min-w-64 px-4 py-3 text-slate-400">{{ instrument.description || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ instrument.currency_base || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ instrument.currency_profit || '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ formatNumber(instrument.point) }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">
            {{ formatNumber(instrument.volume_min) }}-{{ formatNumber(instrument.volume_max) }}
          </td>
          <td class="whitespace-nowrap px-4 py-3">
            <button
              class="rounded-lg border px-3 py-1.5 text-xs font-semibold transition"
              :class="instrument.watchlist_enabled ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100' : 'border-slate-700 bg-slate-950/80 text-slate-300 hover:border-sky-400/70'"
              :disabled="busy"
              @click="setSymbols([instrument.symbol], !instrument.watchlist_enabled)"
            >
              {{ instrument.watchlist_enabled ? 'Enabled' : 'Disabled' }}
            </button>
          </td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type InstrumentRow = {
  id: string;
  symbol: string;
  broker_symbol: string;
  asset_class: string;
  description: string | null;
  currency_base: string | null;
  currency_profit: string | null;
  point: string | number | null;
  volume_min: string | number | null;
  volume_max: string | number | null;
  watchlist_enabled: boolean;
  rank: number | null;
};

type ScannerRow = {
  rank: number;
  symbol: string;
  assetClass: string;
  bid?: string | null;
  ask?: string | null;
  spread?: string | null;
  quote_timestamp?: string | null;
  market_state?: string;
  freshness?: string;
  market_status?: string;
  data_status?: string;
  session_open?: string | null;
  session_close?: string | null;
  next_session_open?: string | null;
  server_time?: string | null;
  local_time?: string | null;
  source?: string | null;
  decision: string;
  confidence: number;
  opportunity_score: number;
  reference_entry?: string | null;
  stop_loss?: string | null;
  take_profit?: string | null;
  risk_reward?: string | null;
  signal_candle_timestamp: string;
  features?: Record<string, string>;
  risk?: { result: string; reason?: string | null; failedRules?: string[] };
  entry_strategy?: string;
  entry_zone_low?: string | null;
  entry_zone_high?: string | null;
  trigger_price?: string | null;
  current_entry_status?: string;
  entry_plan?: {
    entry_strategy?: string;
    entry_zone_low?: string | null;
    entry_zone_high?: string | null;
    trigger_price?: string | null;
    current_entry_status?: string;
  };
};

type ScannerResponse = {
  status: { connected: boolean; demo_verified: boolean; blocked_reason?: string | null };
  autoDemoEnabled: boolean;
  scanner: ScannerRow[];
  watchlistMarketSummary?: {
    open: number;
    total: number;
    nextMarketOpen: string | null;
    nextMarketOpenSymbol: string | null;
    nextMarketOpenLocal: string | null;
    nextH1Analysis: string | null;
  };
};

const { apiFetch } = useApi();
const search = ref('');
const assetFilter = ref('ALL');
const enabledFilter = ref('ALL');
const scanFilter = ref('ALL');
const selected = ref(new Set<string>());
const busy = ref(false);
const message = ref('');
const errorText = ref('');
const scanResultsCard = ref<{ $el?: HTMLElement } | null>(null);

const { data: instrumentData, refresh: refreshInstruments } = await useAsyncData(
  'mt5-instruments',
  () => apiFetch<{ instruments: InstrumentRow[] }>('/mt5/instruments'),
);
const { data: scanner, refresh: refreshScanner } = await useAsyncData<ScannerResponse>(
  'mt5-scanner-page',
  () => apiFetch('/mt5/scanner'),
);

const instruments = computed(() => instrumentData.value?.instruments ?? []);
const enabledCount = computed(() => instruments.value.filter((instrument) => instrument.watchlist_enabled).length);
const enabledInstruments = computed(() => instruments.value.filter((instrument) => instrument.watchlist_enabled));
const selectedSymbols = computed(() => [...selected.value]);
const scanFilters = [
  { label: 'All Results', value: 'ALL' },
  { label: 'Open Now', value: 'OPEN' },
  { label: 'Closed', value: 'CLOSED' },
  { label: 'Tradable Now', value: 'TRADABLE' },
  { label: 'Stale', value: 'STALE' },
] as const;
const filteredInstruments = computed(() => {
  const term = search.value.trim().toLowerCase();
  return instruments.value.filter((instrument) => {
    const matchesSearch = !term
      || instrument.symbol.toLowerCase().includes(term)
      || (instrument.description ?? '').toLowerCase().includes(term);
    const matchesClass = assetFilter.value === 'ALL' || instrument.asset_class === assetFilter.value;
    const matchesEnabled = enabledFilter.value === 'ALL'
      || (enabledFilter.value === 'ENABLED' && instrument.watchlist_enabled)
      || (enabledFilter.value === 'DISABLED' && !instrument.watchlist_enabled);
    return matchesSearch && matchesClass && matchesEnabled;
  });
});
const filteredScannerRows = computed(() => {
  const rows = scanner.value?.scanner ?? [];
  if (scanFilter.value === 'OPEN') return rows.filter((row) => row.market_status === 'OPEN');
  if (scanFilter.value === 'CLOSED') return rows.filter((row) => row.market_status && row.market_status !== 'OPEN');
  if (scanFilter.value === 'TRADABLE') return rows.filter((row) => row.market_status === 'OPEN' && row.data_status === 'LIVE');
  if (scanFilter.value === 'STALE') return rows.filter((row) => row.data_status === 'STALE');
  return rows;
});

const suggested = computed(() => {
  const wanted = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'];
  return instruments.value.filter((instrument) => {
    const normalized = instrument.symbol.replace(/[^A-Z]/gi, '').toUpperCase();
    return wanted.some((symbol) => normalized.includes(symbol));
  }).slice(0, 12);
});

function toggleSelected(symbol: string) {
  const next = new Set(selected.value);
  if (next.has(symbol)) next.delete(symbol);
  else next.add(symbol);
  selected.value = next;
}

async function setSymbols(symbols: string[], enabled: boolean) {
  busy.value = true;
  message.value = '';
  errorText.value = '';
  try {
    const result = await apiFetch<{ updated: number }>('/mt5/watchlist', {
      method: 'PATCH',
      body: { symbols, enabled },
    });
    message.value = `${enabled ? 'Enabled' : 'Disabled'} ${result.updated} watchlist symbol${result.updated === 1 ? '' : 's'}.`;
    selected.value = new Set();
    await Promise.all([refreshInstruments(), refreshScanner()]);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Watchlist update failed';
  } finally {
    busy.value = false;
  }
}

async function setSelected(enabled: boolean) {
  await setSymbols(selectedSymbols.value, enabled);
}

async function syncInstruments() {
  busy.value = true;
  message.value = '';
  errorText.value = '';
  try {
    const result = await apiFetch<{ imported: number }>('/mt5/sync-instruments', { method: 'POST' });
    message.value = `Imported or refreshed ${result.imported} MT5 instruments.`;
    await refreshInstruments();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Instrument sync failed';
  } finally {
    busy.value = false;
  }
}

async function runScanNow() {
  busy.value = true;
  message.value = '';
  errorText.value = '';
  try {
    scanner.value = await apiFetch<ScannerResponse>('/mt5/scanner/run', { method: 'POST' });
    message.value = `Scanned ${scanner.value.scanner.length} enabled watchlist symbol${scanner.value.scanner.length === 1 ? '' : 's'}.`;
    await nextTick();
    scanResultsCard.value?.$el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Scanner run failed';
  } finally {
    busy.value = false;
  }
}

async function refreshAll() {
  busy.value = true;
  message.value = '';
  errorText.value = '';
  try {
    await Promise.all([refreshInstruments(), refreshScanner()]);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Refresh failed';
  } finally {
    busy.value = false;
  }
}

function formatNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '-';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : String(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function labelAsset(value: string) {
  return value.replace('_CFD', '').replace('_', ' ');
}

function decisionClass(value: string) {
  if (value === 'BUY') return 'text-emerald-300';
  if (value === 'SELL') return 'text-rose-300';
  return 'text-slate-300';
}

function marketLabel(row: ScannerRow) {
  const status = row.market_status ?? ((row.freshness ?? row.market_state) === 'MARKET_CLOSED' ? 'CLOSED' : 'UNKNOWN');
  if (status === 'TRADE_DISABLED') return '⚫ TRADE_DISABLED';
  return status;
}

function marketClass(row: ScannerRow) {
  const label = marketLabel(row);
  if (label === 'OPEN') return 'text-emerald-300';
  if (label === '⚫ TRADE_DISABLED') return 'text-slate-500';
  if (label === 'QUOTE_ONLY') return 'text-sky-300';
  if (label === 'UNKNOWN') return 'text-rose-300';
  return 'text-amber-200';
}

function displayDecision(row: ScannerRow) {
  if (row.market_status && row.market_status !== 'OPEN') return `${row.market_status} / NO_TRADE`;
  if (row.data_status && row.data_status !== 'LIVE') return `${row.data_status} / NO_TRADE`;
  if ((row.freshness ?? row.market_state) === 'MARKET_CLOSED') return 'MARKET CLOSED / NO_TRADE';
  return row.decision;
}

function riskLabel(row: ScannerRow) {
  const failed = row.risk?.failedRules ?? [];
  if (failed.includes('MARKET_CLOSED')) return 'MARKET_CLOSED';
  if (failed.includes('BLOCKED_MARKET_CLOSED')) return 'BLOCKED_MARKET_CLOSED';
  if (failed.includes('STALE_DATA')) return 'STALE_DATA';
  return row.risk?.result || '-';
}

function entryTrigger(row: ScannerRow) {
  const plan = row.entry_plan;
  const strategy = plan?.entry_strategy ?? row.entry_strategy;
  if (strategy === 'PULLBACK') return `${plan?.entry_zone_low ?? row.entry_zone_low ?? '-'}-${plan?.entry_zone_high ?? row.entry_zone_high ?? '-'}`;
  if (strategy === 'BREAKOUT') return plan?.trigger_price ?? row.trigger_price ?? '-';
  if (strategy === 'MARKET_NOW') return row.reference_entry ?? '-';
  return '-';
}
</script>
