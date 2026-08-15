<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Hourly Trading</h1>
      <p class="page-subtitle">
        Primary strategy — one decision per newly closed 1H candle, evaluated server-side by the
        hourly scheduler (no browser required). Every BUY/SELL decision still creates a
        PENDING_APPROVAL proposal — nothing is submitted to the PAPER broker without owner
        approval.
      </p>
    </div>

    <div
      v-if="toggleMessage"
      class="notice-info"
    >
      {{ toggleMessage }}
    </div>
    <div
      v-if="toggleError"
      class="notice-error"
    >
      {{ toggleError }}
    </div>

    <section class="rounded-lg border border-slate-800 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="font-semibold text-white">Hourly Trading Mode</h2>
          <p class="mt-1 text-sm text-slate-400">
            When disabled, the scheduler still ticks but every hourly decision is rejected
            server-side before a proposal is created.
          </p>
          <div class="mt-3">
            <StatusPill :label="hourlyMode?.enabled ? 'HOURLY MODE ENABLED' : 'HOURLY MODE DISABLED'" />
          </div>
        </div>
        <button
          class="rounded-lg border px-4 py-2 text-sm font-semibold transition"
          :class="hourlyMode?.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
          :disabled="toggleBusy"
          @click="toggleHourlyMode"
        >
          {{ hourlyMode?.enabled ? 'Disable' : 'Enable' }}
        </button>
      </div>
    </section>

    <UiCard
      title="Watchlist"
      subtitle="Symbols the hourly scheduler evaluates once per closed candle. Disabled symbols are skipped entirely."
    >
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Add US stock symbol</span>
          <input
            v-model="newSymbol"
            class="field-input uppercase"
            placeholder="MSFT"
            maxlength="6"
          >
        </label>
        <button
          class="rounded-lg border border-sky-400/50 bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/20 disabled:opacity-40"
          :disabled="watchlistBusy || !newSymbol.trim()"
          @click="addSymbol"
        >
          Add to watchlist
        </button>
      </div>
      <div
        v-if="watchlistError"
        class="notice-error mt-3"
      >
        {{ watchlistError }}
      </div>
      <div class="mt-4 divide-y divide-slate-800">
        <div
          v-for="entry in watchlist"
          :key="entry.id"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div class="flex items-center gap-3">
            <span class="font-semibold text-slate-100">{{ entry.symbol }}</span>
            <StatusPill :label="entry.enabled ? 'ENABLED' : 'DISABLED'" />
            <span
              v-if="entry.lastProcessedCandle"
              class="text-xs text-slate-500"
            >
              Last candle: {{ new Date(entry.lastProcessedCandle).toLocaleString() }}
            </span>
          </div>
          <button
            class="rounded-lg border px-3 py-1.5 text-xs font-semibold transition"
            :class="entry.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
            :disabled="watchlistBusy"
            @click="toggleWatchlistSymbol(entry)"
          >
            {{ entry.enabled ? 'Disable' : 'Enable' }}
          </button>
        </div>
        <EmptyState
          v-if="!watchlist.length"
          title="No watchlist symbols"
          message="Add a symbol above to have the scheduler start evaluating it."
        />
      </div>
    </UiCard>

    <section class="rounded-lg border border-sky-400/40 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">HOURLY TREND ANALYSIS / PAPER ONLY</div>
          <h2 class="mt-1 text-lg font-semibold">Analyze a Watchlist Symbol</h2>
          <p class="mt-1 text-xs text-slate-500">
            Manual "run now" for debugging — the scheduler runs this automatically once per
            closed candle for every enabled watchlist symbol.
          </p>
        </div>
        <StatusPill label="OWNER APPROVAL REQUIRED" />
      </div>

      <form
        class="mt-4 grid gap-3 md:grid-cols-[1.2fr_auto_auto]"
        @submit.prevent="analyze"
      >
        <label class="block">
          <span class="text-xs uppercase text-slate-500">US stock symbol</span>
          <select
            v-model="form.symbol"
            class="field-input"
            required
          >
            <option
              v-for="entry in watchlist"
              :key="entry.symbol"
              :value="entry.symbol"
            >
              {{ entry.symbol }}
            </option>
          </select>
        </label>
        <button
          class="mt-5 rounded-lg border border-sky-400/50 bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/20 disabled:opacity-40"
          :disabled="analysisBusy || !watchlist.length"
          type="submit"
        >
          Analyze
        </button>
        <button
          class="btn-primary mt-5"
          :disabled="submitBusy || !result || result.analysis.decision === 'HOLD'"
          type="button"
          @click="submitForApproval"
        >
          Submit for Approval
        </button>
      </form>

      <div
        v-if="analysisError"
        class="notice-error mt-4"
      >
        {{ analysisError }}
      </div>
      <div
        v-if="submitError"
        class="notice-error mt-4"
      >
        {{ submitError }}
      </div>
      <div
        v-if="submitMessage"
        class="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100"
      >
        {{ submitMessage }}
        <NuxtLink
          v-if="createdProposalId"
          class="ml-2 font-semibold underline"
          :to="`/proposals?proposalId=${createdProposalId}`"
        >
          Open generated proposal
        </NuxtLink>
      </div>

      <div
        v-if="result"
        class="mt-4 space-y-4"
      >
        <CandlestickChart
          title="1H candles"
          :bars="chartBars"
          :entry="result.analysis.decision !== 'HOLD' ? Number(result.analysis.entry_price) : null"
          :stop-loss="maybeNumber(result.analysis.stop_loss)"
          :take-profit="maybeNumber(result.analysis.take_profit)"
          :value-label="money(result.analysis.entry_price)"
        />

        <div class="grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border border-emerald-400/30 bg-slate-950/70 p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-xs font-semibold uppercase tracking-wide text-emerald-300">HOURLY ANALYSIS</div>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <StatusPill :label="result.analysis.decision" />
                  <StatusPill :label="result.analysis.session_status" />
                  <StatusPill :label="result.hasOpenPosition ? 'POSITION OPEN' : 'NO POSITION'" />
                </div>
              </div>
              <div class="text-right text-xs text-slate-500">
                Confidence
                <div class="mt-1 text-sm font-semibold text-slate-100">{{ percent(result.analysis.confidence) }}</div>
              </div>
            </div>

            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs uppercase text-slate-500">Candle (UTC)</dt>
                <dd class="mt-1 text-slate-100">{{ new Date(result.analysis.candle_timestamp).toLocaleString() }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">1h Trend</dt>
                <dd class="mt-1 text-slate-100">{{ result.analysis.trend_direction }} ({{ pct(result.analysis.trend_strength_pct) }})</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Momentum / Volume</dt>
                <dd class="mt-1 text-slate-100">{{ pct(result.analysis.momentum_pct) }} / {{ ratio(result.analysis.volume_ratio) }}x</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Structure</dt>
                <dd class="mt-1 text-slate-100">
                  <StatusPill :label="result.analysis.breakout ? 'BREAKOUT' : 'PULLBACK'" />
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Higher timeframe</dt>
                <dd class="mt-1 text-slate-100">
                  <StatusPill :label="result.analysis.higher_tf_confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'" />
                  {{ result.analysis.higher_tf_trend_direction }}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">ATR / Volatility</dt>
                <dd class="mt-1 text-slate-100">{{ money(result.analysis.atr) }} ({{ pct(result.analysis.atr_pct) }})</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Liquidity</dt>
                <dd class="mt-1 text-slate-100">{{ pct(result.analysis.spread_pct) }} spread — {{ result.analysis.liquidity_ok ? 'OK' : 'TOO WIDE' }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Entry</dt>
                <dd class="mt-1 text-slate-100">{{ money(result.analysis.entry_price) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Stop loss / Take profit</dt>
                <dd class="mt-1 text-slate-100">{{ maybeMoney(result.analysis.stop_loss) }} / {{ maybeMoney(result.analysis.take_profit) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Risk/reward</dt>
                <dd class="mt-1 text-slate-100">{{ ratio(result.analysis.risk_reward) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Expected holding</dt>
                <dd class="mt-1 text-slate-100">{{ result.analysis.expected_holding_hours }}h</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Strategy version</dt>
                <dd class="mt-1 text-slate-100">{{ result.analysis.strategy_version }}</dd>
              </div>
            </dl>

            <div class="mt-4">
              <div class="text-xs uppercase text-slate-500">Reasons</div>
              <ul class="mt-2 space-y-2 text-sm text-slate-300">
                <li
                  v-for="reason in result.analysis.reasons"
                  :key="reason"
                >
                  {{ reason }}
                </li>
              </ul>
            </div>
          </div>

          <div class="rounded-lg border border-sky-400/30 bg-slate-950/70 p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">RISK ENGINE DECISION</div>
                <div class="mt-2">
                  <StatusPill :label="result.sizingPreview ? (result.sizingPreview.passed ? 'PASS' : 'REJECT') : 'N/A'" />
                </div>
              </div>
            </div>

            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs uppercase text-slate-500">Position size</dt>
                <dd class="mt-1 text-slate-100">{{ quantity(result.sizingPreview?.quantity) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Max loss / budget</dt>
                <dd class="mt-1 text-slate-100">{{ maybeMoney(snapshotString('maxLoss')) }} / {{ maybeMoney(snapshotString('riskBudget')) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Spread / slippage</dt>
                <dd class="mt-1 text-slate-100">{{ spreadSlippage() }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Cooldown</dt>
                <dd class="mt-1 text-slate-100">{{ cooldownStatus() }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Daily loss used / limit</dt>
                <dd class="mt-1 text-slate-100">{{ maybeMoney(snapshotString('dailyLossUsed')) }} / {{ maybeMoney(snapshotString('dailyLossLimit')) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Pending orders</dt>
                <dd class="mt-1 text-slate-100">{{ pendingOrderStatus() }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Trades today (symbol)</dt>
                <dd class="mt-1 text-slate-100">{{ tradeCounts()?.symbolToday ?? '-' }} / {{ tradeCounts()?.symbolLimit ?? '-' }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase text-slate-500">Trades today (total)</dt>
                <dd class="mt-1 text-slate-100">{{ tradeCounts()?.totalToday ?? '-' }} / {{ tradeCounts()?.totalLimit ?? '-' }}</dd>
              </div>
            </dl>

            <div class="mt-4">
              <ProgressMeter
                label="Daily Loss Used vs Limit"
                :percent="dailyLossPercent()"
                :value-label="`${maybeMoney(snapshotString('dailyLossUsed'))} / ${maybeMoney(snapshotString('dailyLossLimit'))}`"
                :status-label="result.sizingPreview ? (result.sizingPreview.passed ? 'PASS' : 'REJECT') : 'N/A'"
                :helper="result.sizingPreview?.failedRules.join(', ') || 'No failed rules'"
              />
            </div>
          </div>
        </div>
      </div>
    </section>

    <UiCard
      title="Hourly Settings (Phase 27)"
      subtitle="Current configuration. Edit via system_settings; only the master toggle above is editable here."
      body-class="p-0"
    >
      <dl class="divide-y divide-slate-800">
        <div
          v-for="setting in hourlySettings"
          :key="setting.key"
          class="grid gap-1 px-4 py-3 md:grid-cols-3"
        >
          <dt class="text-sm text-slate-400">{{ setting.key }}</dt>
          <dd class="text-sm font-semibold text-slate-100 md:col-span-1">{{ setting.value }}</dd>
          <dd class="text-sm text-slate-500">{{ setting.description ?? '-' }}</dd>
        </div>
      </dl>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type HourlyAnalysis = {
  symbol: string;
  candle_timestamp: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasons: string[];
  strategy_version: string;
  trend_direction: string;
  trend_strength_pct: string;
  momentum_pct: string;
  volume_ratio: string;
  breakout: boolean;
  pullback: boolean;
  higher_tf_trend_direction: string;
  higher_tf_confirmed: boolean;
  atr: string;
  atr_pct: string;
  spread_pct: string;
  liquidity_ok: boolean;
  entry_price: string;
  stop_loss: string | null;
  take_profit: string | null;
  risk_reward: string | null;
  expected_holding_hours: number;
  session_status: string;
};
type SizingPreview = {
  quantity: string;
  passed: boolean;
  failedRules: string[];
  snapshot: Record<string, unknown>;
};
type AnalysisResponse = {
  analysis: HourlyAnalysis;
  sizingPreview: SizingPreview | null;
  hasOpenPosition: boolean;
};
type HourlyDecisionResult = {
  analysis: HourlyAnalysis;
  proposal: { id: string; status: string } | null;
};
type WatchlistEntry = {
  id: string;
  symbol: string;
  enabled: boolean;
  lastProcessedCandle: string | null;
};
type Setting = { key: string; value: unknown; description: string | null };
type HourlyModeSetting = { enabled: boolean };
type Bar = { timestamp: string; open: string; high: string; low: string; close: string };

const { apiFetch } = useApi();

const watchlist = ref<WatchlistEntry[]>([]);
const hourlySettings = ref<Setting[]>([]);
const hourlyMode = ref<HourlyModeSetting | null>(null);
const result = ref<AnalysisResponse | null>(null);
const chartBars = ref<{ timestamp: string; open: number; high: number; low: number; close: number }[]>([]);
const form = reactive({ symbol: '' });
const newSymbol = ref('');

const analysisBusy = ref(false);
const analysisError = ref('');
const submitBusy = ref(false);
const submitError = ref('');
const submitMessage = ref('');
const createdProposalId = ref('');
const toggleBusy = ref(false);
const toggleMessage = ref('');
const toggleError = ref('');
const watchlistBusy = ref(false);
const watchlistError = ref('');

async function loadWatchlist() {
  const res = await apiFetch<{ watchlist: WatchlistEntry[] }>('/hourly/watchlist');
  watchlist.value = res.watchlist;
  if (!form.symbol && watchlist.value.length) {
    form.symbol = watchlist.value[0].symbol;
  }
}

async function loadSettings() {
  const all = await apiFetch<Setting[]>('/settings');
  hourlySettings.value = all.filter((setting) => setting.key.startsWith('phase27_'));
}

async function loadHourlyMode() {
  hourlyMode.value = await apiFetch<HourlyModeSetting>('/settings/hourly-mode');
}

await Promise.all([loadWatchlist(), loadSettings(), loadHourlyMode()]);

async function toggleHourlyMode() {
  toggleBusy.value = true;
  toggleMessage.value = '';
  toggleError.value = '';
  try {
    const enabled = !(hourlyMode.value?.enabled ?? true);
    hourlyMode.value = await apiFetch<HourlyModeSetting>('/settings/hourly-mode', {
      method: 'PUT',
      body: { enabled },
    });
    toggleMessage.value = `Hourly trading mode ${enabled ? 'enabled' : 'disabled'}.`;
    await loadSettings();
  } catch (err) {
    toggleError.value = err instanceof Error && err.message
      ? `Hourly trading mode update failed: ${err.message}`
      : 'Hourly trading mode update failed. Please try again.';
  } finally {
    toggleBusy.value = false;
  }
}

async function addSymbol() {
  watchlistBusy.value = true;
  watchlistError.value = '';
  try {
    await apiFetch('/hourly/watchlist', {
      method: 'POST',
      body: { symbol: newSymbol.value.trim().toUpperCase() },
    });
    newSymbol.value = '';
    await loadWatchlist();
  } catch (err) {
    watchlistError.value = err instanceof Error ? err.message : 'Failed to add symbol.';
  } finally {
    watchlistBusy.value = false;
  }
}

async function toggleWatchlistSymbol(entry: WatchlistEntry) {
  watchlistBusy.value = true;
  watchlistError.value = '';
  try {
    await apiFetch(`/hourly/watchlist/${entry.id}`, {
      method: 'PATCH',
      body: { enabled: !entry.enabled },
    });
    await loadWatchlist();
  } catch (err) {
    watchlistError.value = err instanceof Error ? err.message : 'Failed to update symbol.';
  } finally {
    watchlistBusy.value = false;
  }
}

async function loadChartBars(symbol: string) {
  try {
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const bars = await apiFetch<Bar[]>(
      `/market-data/bars/${encodeURIComponent(symbol)}?timeframe=1Hour&start=${encodeURIComponent(start)}&limit=60`,
    );
    chartBars.value = bars.map((bar) => ({
      timestamp: bar.timestamp,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
    }));
  } catch {
    chartBars.value = [];
  }
}

async function analyze() {
  analysisBusy.value = true;
  analysisError.value = '';
  result.value = null;
  try {
    const [analysisResult] = await Promise.all([
      apiFetch<AnalysisResponse>(`/hourly/analysis/${encodeURIComponent(form.symbol)}`),
      loadChartBars(form.symbol),
    ]);
    result.value = analysisResult;
  } catch (err) {
    analysisError.value = err instanceof Error ? err.message : 'Failed to analyze symbol.';
  } finally {
    analysisBusy.value = false;
  }
}

async function submitForApproval() {
  submitBusy.value = true;
  submitError.value = '';
  submitMessage.value = '';
  createdProposalId.value = '';
  try {
    const decisionResult = await apiFetch<HourlyDecisionResult>('/signals/hourly-decision', {
      method: 'POST',
      body: { symbol: form.symbol },
    });
    if (decisionResult.proposal) {
      createdProposalId.value = decisionResult.proposal.id;
      submitMessage.value = `Hourly ${decisionResult.analysis.decision} proposal created. Status: ${decisionResult.proposal.status}.`;
    } else {
      submitMessage.value = 'Decision is HOLD — no proposal was created.';
    }
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Failed to submit hourly decision.';
  } finally {
    submitBusy.value = false;
  }
}

type CooldownSnapshot = { configuredSeconds?: number; remainingSeconds?: number; passed?: boolean };
type TradeCountsSnapshot = { symbolToday?: number; symbolLimit?: number; totalToday?: number; totalLimit?: number };

function snapshotString(key: string): string | null {
  const value = result.value?.sizingPreview?.snapshot[key];
  return typeof value === 'string' ? value : null;
}
function tradeCounts(): TradeCountsSnapshot | null {
  const value = result.value?.sizingPreview?.snapshot.tradeCounts;
  return value && typeof value === 'object' ? value as TradeCountsSnapshot : null;
}
function cooldownSnapshot(): CooldownSnapshot | null {
  const value = result.value?.sizingPreview?.snapshot.cooldown;
  return value && typeof value === 'object' ? value as CooldownSnapshot : null;
}
function money(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}
function maybeMoney(value: string | null | undefined): string {
  return value ? money(value) : '-';
}
function maybeNumber(value: string | null | undefined): number | null {
  return value ? Number(value) : null;
}
function pct(value: string | null | undefined): string {
  if (!value) return '-';
  return `${Number(value).toFixed(2)}%`;
}
function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(0)}%`;
}
function ratio(value: string | null | undefined): string {
  return value ? Number(value).toFixed(2) : '-';
}
function quantity(value: string | null | undefined): string {
  if (!value) return '-';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
function spreadSlippage(): string {
  const spread = snapshotString('spreadPct');
  const slippage = snapshotString('estimatedSlippagePct');
  return `${spread ? pct(spread) : '-'} spread / ${slippage ? pct(slippage) : '-'} slippage`;
}
function cooldownStatus(): string {
  const cooldown = cooldownSnapshot();
  if (!cooldown) return '-';
  if (cooldown.passed) return 'PASS';
  return `BLOCKED (${cooldown.remainingSeconds ?? 0}s remaining)`;
}
function dailyLossPercent(): number {
  const used = Number(snapshotString('dailyLossUsed') ?? 0);
  const limit = Number(snapshotString('dailyLossLimit') ?? 0);
  return limit > 0 ? (used / limit) * 100 : 0;
}
function pendingOrderStatus(): string {
  const value = result.value?.sizingPreview?.snapshot.conflictingPendingOrders;
  const count = Array.isArray(value) ? value.length : 0;
  return count > 0 ? `BLOCKED (${count})` : 'CLEAR';
}
</script>
