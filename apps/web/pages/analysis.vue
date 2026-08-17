<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">AI trading plan</p>
        <h1 class="page-title">AI Analysis</h1>
        <p class="page-subtitle">
          Select a symbol to immediately see market status, price, BUY/SELL/WAIT, entry timing, SL/TP, position size, max loss, target profit, and Risk Engine result.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-primary" :disabled="busy || !selectedSymbol" @click="loadSelected(false)">
          {{ busy ? 'Loading...' : 'Refresh Selected' }}
        </button>
        <button class="btn-success" :disabled="busy || !selectedSymbol" @click="loadSelected(true)">
          {{ busy ? 'Analyzing...' : 'Analyze Selected Symbol' }}
        </button>
        <button class="btn-primary" :disabled="busy" @click="runScan">Scan Watchlist</button>
      </div>
    </header>

    <div v-if="message" class="notice-info">{{ message }}</div>
    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <UiCard title="Choose Symbol" subtitle="Only asset classes that exist in synced MT5 demo instruments are shown.">
      <div class="grid gap-3 lg:grid-cols-[12rem_1fr_16rem]">
        <select v-model="assetFilter" class="field-input">
          <option v-for="asset in availableAssets" :key="asset" :value="asset">{{ asset === 'ALL' ? 'All markets' : labelAsset(asset) }}</option>
        </select>
        <input v-model="search" class="field-input" placeholder="Search symbol or description">
        <select v-model="selectedSymbol" class="field-input">
          <option value="">Select symbol</option>
          <option v-for="instrument in filteredInstruments" :key="instrument.symbol" :value="instrument.symbol">
            {{ instrument.symbol }} - {{ labelAsset(instrument.asset_class) }}
          </option>
        </select>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          v-for="instrument in filteredInstruments.slice(0, 18)"
          :key="instrument.symbol"
          class="rounded-lg border px-3 py-2 text-left text-xs font-semibold transition"
          :class="instrument.watchlist_enabled ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100' : 'border-slate-700 bg-slate-950/80 text-slate-300 hover:border-sky-400/70'"
          :disabled="busy"
          @click="toggleWatch(instrument)"
        >
          {{ instrument.watchlist_enabled ? 'Watching' : 'Watch' }} {{ instrument.symbol }}
        </button>
      </div>
    </UiCard>

    <section v-if="plan" class="rounded-lg border p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)]" :class="planBorder">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p class="text-xs font-bold uppercase tracking-widest text-slate-500">{{ labelAsset(plan.assetClass) }}</p>
          <h2 class="mt-1 text-3xl font-semibold text-white">{{ plan.symbol }}</h2>
          <div class="mt-3 flex flex-wrap gap-2">
            <StatusPill :label="marketStatusLabel" />
            <StatusPill :label="plan.market.dataStatus" />
            <StatusPill :label="`AI ${plan.decision.action}`" />
            <StatusPill :label="plan.entryPlan.beginner_label" />
            <StatusPill :label="riskStatus" />
          </div>
        </div>
        <div class="text-left lg:text-right">
          <p class="text-xs text-slate-500">Confidence / Score</p>
          <p class="mt-1 text-2xl font-semibold text-white">
            {{ percent(plan.decision.confidence) }} · {{ round(plan.decision.opportunityScore) }}/100
          </p>
          <p class="mt-2 text-xs text-slate-400">Plan expires {{ dateText(plan.entryPlan.valid_until) }}</p>
        </div>
      </div>

      <div v-if="isClosed" class="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/10 p-5">
        <h3 class="text-xl font-semibold text-amber-100">MARKET CLOSED</h3>
        <p class="mt-2 text-sm font-semibold text-amber-100">CANNOT TRADE NOW</p>
        <p class="mt-3 text-sm leading-6 text-amber-50/90">
          This market is currently closed. No new demo trade can be entered.
        </p>
      </div>

      <div v-else-if="plan.decision.action === 'WAIT'" class="mt-5 rounded-lg border border-slate-700 bg-slate-950/70 p-5">
        <h3 class="text-xl font-semibold text-white">AI: WAIT</h3>
        <p class="mt-2 text-sm font-semibold text-amber-200">DO NOT ENTER NOW</p>
        <p class="mt-3 text-sm leading-6 text-slate-300">{{ plan.explanation.beginnerSummary }}</p>
      </div>

      <section class="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <InfoTile label="Current / Last Price" :value="priceText(plan.quote.currentPrice)" />
        <InfoTile label="Bid / Ask" :value="`${priceText(plan.quote.bid)} / ${priceText(plan.quote.ask)}`" />
        <InfoTile label="Spread" :value="valueText(plan.quote.spread)" />
        <InfoTile label="Last Quote Time" :value="dateText(plan.quote.quoteTimestamp)" />
        <InfoTile label="Session Status" :value="plan.market.status" />
        <InfoTile label="Next Open" :value="plan.market.nextOpenThailand ?? '-'" />
        <InfoTile label="Next Close" :value="plan.market.nextCloseThailand ?? '-'" />
        <InfoTile label="Thailand Time" :value="plan.market.thailandTime ?? '-'" />
        <InfoTile label="Broker / Server Time" :value="dateText(plan.market.serverTime)" />
        <InfoTile label="Opens / Closes In" :value="plan.market.opensIn ?? plan.market.closesIn ?? '-'" />
        <InfoTile label="Data Freshness" :value="plan.quote.quoteAgeSeconds === null ? '-' : `${plan.quote.quoteAgeSeconds}s old`" />
        <InfoTile label="Session Source" :value="plan.market.source" />
      </section>

      <section class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-5">
        <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">When to Enter</h3>
        <p class="mt-2 text-2xl font-semibold" :class="entryTone">{{ plan.entryPlan.beginner_label }}</p>
        <p class="mt-2 text-sm leading-6 text-slate-300">{{ entryExplanation }}</p>
        <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <InfoTile label="Entry Type" :value="plan.entryPlan.entry_strategy" />
          <InfoTile label="Entry Status" :value="plan.entryPlan.status_label" />
          <InfoTile label="Entry / Reference" :value="priceText(plan.entryPlan.reference_entry)" />
          <InfoTile label="Current Price" :value="priceText(plan.entryPlan.current_price ?? plan.quote.currentPrice)" />
          <InfoTile label="Entry Zone" :value="entryZoneText" />
          <InfoTile label="Trigger Price" :value="priceText(plan.entryPlan.trigger_price)" />
          <InfoTile label="Created At" :value="dateText(plan.generatedAt)" />
          <InfoTile label="Expires At" :value="dateText(plan.entryPlan.valid_until)" />
        </div>
      </section>

      <section class="mt-5 grid gap-4 lg:grid-cols-3">
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
          <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">How Much</h3>
          <div class="mt-4 space-y-3">
            <InfoTile label="Recommended Lot Size" :value="lotText" />
            <InfoTile label="Approx Amount Exposed" :value="money(plan.positionSizing.approximateNotional)" />
            <InfoTile label="Risk Per Account" :value="plan.positionSizing.riskPerAccountPct ? `${plan.positionSizing.riskPerAccountPct}%` : '-'" />
          </div>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
          <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">Protection</h3>
          <div class="mt-4 space-y-3">
            <InfoTile label="Stop Loss" :value="priceText(plan.protection.stopLoss)" tone="loss" />
            <InfoTile label="Take Profit" :value="priceText(plan.protection.takeProfit)" tone="gain" />
            <InfoTile label="Risk / Reward" :value="riskRewardText" />
          </div>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
          <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">AI Expects</h3>
          <div class="mt-4 space-y-3">
            <InfoTile label="Maximum Planned Loss" :value="money(plan.positionSizing.maximumPlannedLoss)" tone="loss" />
            <InfoTile label="Target Profit" :value="money(plan.positionSizing.targetProfit)" tone="gain" />
            <InfoTile label="Holding Time" :value="holdingText" />
          </div>
        </div>
      </section>

      <section class="mt-5 grid gap-4 lg:grid-cols-[1fr_0.85fr]">
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
          <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">Why AI Says This</h3>
          <p class="mt-3 text-sm leading-6 text-slate-300">{{ plan.explanation.beginnerSummary }}</p>
          <ul class="mt-4 space-y-2 text-sm text-slate-300">
            <li v-for="item in plan.explanation.bullets" :key="item">- {{ item }}</li>
          </ul>
        </div>
        <div class="rounded-lg border p-5" :class="plan.risk.result === 'PASS' ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-rose-400/40 bg-rose-400/10'">
          <h3 class="text-sm font-bold uppercase tracking-widest" :class="plan.risk.result === 'PASS' ? 'text-emerald-200' : 'text-rose-200'">Risk Engine</h3>
          <p class="mt-3 text-2xl font-semibold text-white">{{ plan.risk.label }}</p>
          <div v-if="blockedReasons.length" class="mt-4 space-y-2">
            <p v-for="reason in blockedReasons" :key="reason.rule" class="text-sm leading-6 text-slate-100">
              <strong>{{ reason.rule }}:</strong> {{ reason.explanation }}
            </p>
          </div>
          <p v-else class="mt-4 text-sm leading-6 text-emerald-100">
            Risk Engine accepts the planned demo loss and position size. The server will check again before sending an order.
          </p>
        </div>
      </section>

      <details class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
        <summary class="cursor-pointer text-sm font-semibold text-slate-200">Advanced Details</summary>
        <pre class="mt-4 max-h-96 overflow-auto text-xs leading-5 text-slate-400">{{ JSON.stringify(plan.decision.features ?? {}, null, 2) }}</pre>
      </details>

      <div class="mt-5 flex flex-col gap-3 border-t border-slate-800 pt-5 md:flex-row md:items-center md:justify-between">
        <p class="text-sm text-slate-300">{{ tradeButtonHelp }}</p>
        <button class="btn-success" :disabled="busy || !plan.tradeButton.enabled" @click="confirmRow = plan">
          {{ plan.tradeButton.enabled ? 'Trade in Demo' : 'Trade in Demo disabled' }}
        </button>
      </div>
    </section>

    <UiCard v-else title="Select a Symbol" subtitle="Pick a market above to load a complete trading plan immediately.">
      <p class="text-sm leading-6 text-slate-300">
        The plan will show market open/closed, current price, AI recommendation, entry timing, Stop Loss, Take Profit, lot size, max loss, target profit, and Risk Engine status.
      </p>
    </UiCard>

    <UiCard title="Ranked Watchlist Results" subtitle="Optional scan across enabled symbols. Strategy is regenerated only when you press Scan Watchlist.">
      <div v-if="rankedRows.length" class="grid gap-3">
        <button
          v-for="row in rankedRows"
          :key="row.symbol"
          class="rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-sky-400/60"
          @click="selectedSymbol = row.symbol"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="font-semibold text-white">{{ row.symbol }}</span>
            <span class="text-sm text-slate-300">{{ row.decision === 'BUY' || row.decision === 'SELL' ? row.decision : 'WAIT' }} · {{ row.market_status ?? 'UNKNOWN' }} · Score {{ round(row.opportunity_score) }}/100</span>
          </div>
        </button>
      </div>
      <EmptyState v-else title="No scan results yet" message="Enable symbols, then scan the watchlist if you want ranked opportunities." />
    </UiCard>

    <div v-if="confirmRow" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4">
      <section class="w-full max-w-xl rounded-lg border border-sky-400/40 bg-slate-900 p-5 shadow-2xl">
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Owner confirmation required</p>
        <h2 class="mt-2 text-xl font-semibold text-white">Confirm DEMO trade for {{ confirmRow.symbol }}</h2>
        <div class="mt-4 grid gap-2 text-sm text-slate-300">
          <div class="flex justify-between gap-4"><span>AI recommendation</span><strong>{{ confirmRow.decision.action }}</strong></div>
          <div class="flex justify-between gap-4"><span>Entry</span><strong>{{ priceText(confirmRow.entryPlan.reference_entry) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Stop Loss</span><strong class="text-rose-200">{{ priceText(confirmRow.protection.stopLoss) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Take Profit</span><strong class="text-emerald-200">{{ priceText(confirmRow.protection.takeProfit) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Lot size</span><strong>{{ lotText }}</strong></div>
          <div class="flex justify-between gap-4"><span>Max planned loss</span><strong class="text-rose-200">{{ money(confirmRow.positionSizing.maximumPlannedLoss) }}</strong></div>
        </div>
        <p class="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
          DEMO only. The API verifies demo account, market, quote freshness, SL/TP, sizing, and Risk Engine again before sending any order.
        </p>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800" :disabled="busy" @click="confirmRow = null">Cancel</button>
          <button class="btn-success" :disabled="busy" @click="confirmTrade">{{ busy ? 'Submitting...' : 'Confirm Demo Trade' }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type InstrumentRow = { symbol: string; asset_class: string; description?: string | null; watchlist_enabled: boolean };
type DisabledReason = { rule: string; explanation: string };
type AnalysisPlan = {
  generatedAt: string;
  timezone: string;
  symbol: string;
  assetClass: string;
  market: Record<string, any>;
  quote: Record<string, any>;
  decision: Record<string, any>;
  entryPlan: Record<string, any>;
  protection: Record<string, any>;
  positionSizing: Record<string, any>;
  risk: { result: string; label: string; diagnostics: DisabledReason[] };
  explanation: { beginnerSummary: string; bullets: string[] };
  tradeButton: { enabled: boolean; label: string; disabledReasons: DisabledReason[] };
};
type ScannerRow = { symbol: string; decision?: string; market_status?: string; opportunity_score?: number };

const { apiFetch } = useApi();
const busy = ref(false);
const message = ref('');
const errorText = ref('');
const search = ref('');
const assetFilter = ref('ALL');
const selectedSymbol = ref('');
const plan = ref<AnalysisPlan | null>(null);
const confirmRow = ref<AnalysisPlan | null>(null);

const { data: instrumentsData, refresh: refreshInstruments } = await useAsyncData<{ instruments: InstrumentRow[] }>('analysis-instruments-v2', () => apiFetch('/mt5/instruments'));
const { data: scanner, refresh: refreshScanner } = await useAsyncData<Record<string, any>>('analysis-scanner-v2', () => apiFetch('/mt5/scanner'));
useAutoRefresh(refreshLightweight, 10000);

const instruments = computed(() => instrumentsData.value?.instruments ?? []);
const availableAssets = computed(() => ['ALL', ...new Set(instruments.value.map((instrument) => instrument.asset_class).filter(Boolean))]);
const filteredInstruments = computed(() => {
  const term = search.value.trim().toLowerCase();
  return instruments.value.filter((instrument) => {
    const matchesAsset = assetFilter.value === 'ALL' || instrument.asset_class === assetFilter.value;
    const matchesSearch = !term || instrument.symbol.toLowerCase().includes(term) || (instrument.description ?? '').toLowerCase().includes(term);
    return matchesAsset && matchesSearch;
  });
});
const rankedRows = computed<ScannerRow[]>(() => [...(scanner.value?.scanner ?? [])].sort((a, b) => Number(b.opportunity_score ?? 0) - Number(a.opportunity_score ?? 0)));
const isClosed = computed(() => plan.value?.market.status === 'CLOSED');
const marketStatusLabel = computed(() => isClosed.value ? 'MARKET CLOSED' : `MARKET ${plan.value?.market.status ?? 'UNKNOWN'}`);
const riskStatus = computed(() => plan.value?.risk.result === 'PASS' ? 'RISK PASS' : 'TRADE BLOCKED');
const blockedReasons = computed(() => plan.value?.tradeButton.disabledReasons?.length ? plan.value.tradeButton.disabledReasons : plan.value?.risk.diagnostics ?? []);
const planBorder = computed(() => {
  if (plan.value?.tradeButton.enabled) return 'border-emerald-400/40 bg-slate-900/80';
  if (isClosed.value) return 'border-amber-400/40 bg-slate-900/80';
  return 'border-slate-800 bg-slate-900/80';
});
const entryTone = computed(() => {
  const label = plan.value?.entryPlan.beginner_label;
  if (label === 'ENTER NOW') return 'text-emerald-200';
  if (label === 'DO NOT ENTER') return 'text-amber-200';
  return 'text-sky-200';
});
const entryZoneText = computed(() => {
  if (!plan.value) return '-';
  const low = plan.value.entryPlan.entry_zone_low;
  const high = plan.value.entryPlan.entry_zone_high;
  return low && high ? `${priceText(low)} - ${priceText(high)}` : '-';
});
const entryExplanation = computed(() => {
  if (!plan.value) return '';
  const strategy = plan.value.entryPlan.entry_strategy;
  if (strategy === 'MARKET_NOW') return `AI considers the current price acceptable. Enter around ${priceText(plan.value.entryPlan.reference_entry)} if all safety checks still pass.`;
  if (strategy === 'PULLBACK') return `AI recommends waiting for price to move into ${entryZoneText.value} before entering.`;
  if (strategy === 'BREAKOUT') return `Wait until price breaks ${priceText(plan.value.entryPlan.trigger_price)} before entering.`;
  return 'Conditions are not suitable yet. No demo trade should be entered.';
});
const lotText = computed(() => {
  const value = plan.value?.positionSizing.recommendedLotSize ?? confirmRow.value?.positionSizing.recommendedLotSize;
  return Number.isFinite(Number(value)) && Number(value) > 0 ? `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} lot` : '-';
});
const riskRewardText = computed(() => {
  const rr = plan.value?.protection.riskReward;
  return rr ? `1 : ${Number(rr).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-';
});
const holdingText = computed(() => {
  const hours = Number(plan.value?.decision.expectedHoldingHours);
  if (!Number.isFinite(hours) || hours <= 0) return '-';
  return hours <= 4 ? '1-4 hours' : `${hours} hours`;
});
const tradeButtonHelp = computed(() => {
  if (!plan.value) return '';
  if (plan.value.tradeButton.enabled) return 'Demo trade is available. Final server-side checks still run before order submission.';
  const first = blockedReasons.value[0];
  return first ? `Demo trade disabled: ${first.rule} - ${first.explanation}` : 'Demo trade disabled.';
});

watch(selectedSymbol, async (symbol) => {
  if (!symbol) {
    plan.value = null;
    return;
  }
  await loadSelected(false);
});

async function loadSelected(persist: boolean) {
  if (!selectedSymbol.value) return;
  busy.value = true;
  errorText.value = '';
  message.value = '';
  try {
    plan.value = await apiFetch<AnalysisPlan>(`/mt5/analysis/${encodeURIComponent(selectedSymbol.value)}`, { method: persist ? 'POST' : 'GET' });
    message.value = persist ? `New AI analysis saved for ${selectedSymbol.value}.` : '';
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Could not load trading plan';
  } finally {
    busy.value = false;
  }
}

async function refreshLightweight() {
  if (!selectedSymbol.value || busy.value) return;
  await loadSelected(false);
}

async function toggleWatch(instrument: InstrumentRow) {
  busy.value = true;
  errorText.value = '';
  message.value = '';
  try {
    await apiFetch('/mt5/watchlist', { method: 'PATCH', body: { symbols: [instrument.symbol], enabled: !instrument.watchlist_enabled } });
    message.value = `${instrument.watchlist_enabled ? 'Disabled' : 'Enabled'} ${instrument.symbol} for AI scans.`;
    await Promise.all([refreshInstruments(), refreshScanner()]);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Watchlist update failed';
  } finally {
    busy.value = false;
  }
}

async function runScan() {
  busy.value = true;
  errorText.value = '';
  message.value = '';
  try {
    scanner.value = await apiFetch('/mt5/scanner/run', { method: 'POST' });
    message.value = `Scanned ${rankedRows.value.length} enabled symbol${rankedRows.value.length === 1 ? '' : 's'}.`;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Watchlist scan failed';
  } finally {
    busy.value = false;
  }
}

async function confirmTrade() {
  if (!confirmRow.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    const result = await apiFetch<{ executed: boolean; risk?: { failedRules?: string[]; failed_rules?: string[] } }>(`/mt5/assisted-demo/${encodeURIComponent(confirmRow.value.symbol)}`, { method: 'POST' });
    if (result.executed) await navigateTo('/positions');
    else errorText.value = `Trade blocked: ${((result.risk?.failedRules ?? result.risk?.failed_rules) ?? ['Risk Engine rejected']).join(', ')}`;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Demo trade was blocked';
  } finally {
    busy.value = false;
    confirmRow.value = null;
  }
}

function priceText(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || value === null || value === undefined || value === '') return '-';
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function valueText(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
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

function round(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function dateText(value: unknown) {
  if (!value) return '-';
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '-';
}

function labelAsset(value: string | undefined) {
  return String(value ?? 'OTHER').replace('_CFD', '').replace('_', ' ');
}
</script>
