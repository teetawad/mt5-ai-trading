<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Crypto Mode</h1>
      <p class="page-subtitle">
        Multi-timeframe analysis (1h trend / 15m setup / 5m entry), 24/7 — crypto markets never
        close. Every BUY/SELL decision still creates a PENDING_APPROVAL proposal — nothing is
        submitted to the PAPER broker without owner approval.
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
          <h2 class="font-semibold text-white">Crypto Trading Mode</h2>
          <p class="mt-1 text-sm text-slate-400">
            When disabled, crypto decisions are rejected server-side even if requested.
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <StatusPill :label="cryptoMode?.enabled ? 'CRYPTO MODE ENABLED' : 'CRYPTO MODE DISABLED'" />
            <StatusPill label="MARKET OPEN 24/7" />
          </div>
        </div>
        <button
          class="rounded-lg border px-4 py-2 text-sm font-semibold transition"
          :class="cryptoMode?.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
          :disabled="toggleBusy"
          @click="toggleCryptoMode"
        >
          {{ cryptoMode?.enabled ? 'Disable' : 'Enable' }}
        </button>
      </div>
    </section>

    <section class="rounded-lg border border-sky-400/40 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">MULTI-TIMEFRAME ANALYSIS / PAPER ONLY</div>
          <h2 class="mt-1 text-lg font-semibold">Analyze a Symbol</h2>
        </div>
        <StatusPill label="OWNER APPROVAL REQUIRED" />
      </div>

      <form
        class="mt-4 grid gap-3 md:grid-cols-[1.2fr_auto_auto]"
        @submit.prevent="analyze"
      >
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Crypto pair</span>
          <select
            v-model="form.symbol"
            class="field-input"
            required
          >
            <option
              v-for="symbol in symbolOptions?.symbols ?? []"
              :key="symbol"
              :value="symbol"
            >
              {{ symbol }}
            </option>
          </select>
        </label>
        <button
          class="mt-5 rounded-lg border border-sky-400/50 bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/20 disabled:opacity-40"
          :disabled="analysisBusy || !(symbolOptions?.symbols?.length)"
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
        class="mt-4 grid gap-4 lg:grid-cols-2"
      >
        <div class="rounded-lg border border-emerald-400/30 bg-slate-950/70 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-emerald-300">AI ANALYSIS</div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <StatusPill :label="result.analysis.decision" />
                <StatusPill label="OPEN 24/7" />
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
              <dt class="text-xs uppercase text-slate-500">1h Trend</dt>
              <dd class="mt-1 text-slate-100">{{ result.analysis.trend_direction }} ({{ pct(result.analysis.trend_strength_pct) }})</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">15m Setup</dt>
              <dd class="mt-1 text-slate-100">
                <StatusPill :label="result.analysis.setup_confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'" />
                {{ pct(result.analysis.setup_momentum_pct) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">5m Entry</dt>
              <dd class="mt-1 text-slate-100">
                <StatusPill :label="result.analysis.entry_confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'" />
                {{ pct(result.analysis.entry_momentum_pct) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Volume signal</dt>
              <dd class="mt-1 text-slate-100">{{ result.analysis.volume_signal }}</dd>
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
              <dt class="text-xs uppercase text-slate-500">Fee (bps) / est.</dt>
              <dd class="mt-1 text-slate-100">{{ snapshotNumber('feeBps') ?? '-' }} / {{ maybeMoney(snapshotString('estimatedFee')) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Cooldown</dt>
              <dd class="mt-1 text-slate-100">{{ cooldownStatus() }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Daily loss (crypto / platform)</dt>
              <dd class="mt-1 text-slate-100">{{ dailyLossStatus() }}</dd>
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
              label="Crypto Daily Loss Used vs Limit"
              :percent="dailyLossPercent()"
              :value-label="dailyLossStatus()"
              :status-label="result.sizingPreview ? (result.sizingPreview.passed ? 'PASS' : 'REJECT') : 'N/A'"
              :helper="result.sizingPreview?.failedRules.join(', ') || 'No failed rules'"
            />
          </div>
        </div>
      </div>
    </section>

    <UiCard
      title="Crypto Settings (Phase 26)"
      subtitle="Current configuration. Edit via system_settings; only the master toggle above is editable here."
      body-class="p-0"
    >
      <dl class="divide-y divide-slate-800">
        <div
          v-for="setting in cryptoSettings"
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
type CryptoAnalysis = {
  symbol: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasons: string[];
  trend_direction: string;
  trend_strength_pct: string;
  setup_momentum_pct: string;
  setup_confirmed: boolean;
  entry_momentum_pct: string;
  entry_confirmed: boolean;
  volume_signal: string;
  atr: string;
  atr_pct: string;
  spread_pct: string;
  liquidity_ok: boolean;
  entry_price: string;
  stop_loss: string | null;
  take_profit: string | null;
  risk_reward: string | null;
  market_status: string;
};
type SizingPreview = {
  quantity: string;
  passed: boolean;
  failedRules: string[];
  snapshot: Record<string, unknown>;
};
type AnalysisResponse = {
  analysis: CryptoAnalysis;
  sizingPreview: SizingPreview | null;
  hasOpenPosition: boolean;
};
type CryptoDecisionResult = {
  analysis: CryptoAnalysis;
  proposal: { id: string; status: string } | null;
};
type SymbolOptions = { symbols: string[]; enabled: boolean };
type Setting = { key: string; value: unknown; description: string | null };
type CryptoModeSetting = { enabled: boolean };

const { apiFetch } = useApi();

const symbolOptions = ref<SymbolOptions | null>(null);
const cryptoSettings = ref<Setting[]>([]);
const cryptoMode = ref<CryptoModeSetting | null>(null);
const result = ref<AnalysisResponse | null>(null);
const form = reactive({ symbol: '' });

const analysisBusy = ref(false);
const analysisError = ref('');
const submitBusy = ref(false);
const submitError = ref('');
const submitMessage = ref('');
const createdProposalId = ref('');
const toggleBusy = ref(false);
const toggleMessage = ref('');
const toggleError = ref('');

async function loadSymbols() {
  symbolOptions.value = await apiFetch<SymbolOptions>('/crypto/symbols');
  if (!form.symbol && symbolOptions.value.symbols.length) {
    form.symbol = symbolOptions.value.symbols[0];
  }
}

async function loadSettings() {
  const all = await apiFetch<Setting[]>('/settings');
  cryptoSettings.value = all.filter((setting) => setting.key.startsWith('phase26_'));
}

async function loadCryptoMode() {
  cryptoMode.value = await apiFetch<CryptoModeSetting>('/settings/crypto-trading-mode');
}

await Promise.all([loadSymbols(), loadSettings(), loadCryptoMode()]);

async function toggleCryptoMode() {
  toggleBusy.value = true;
  toggleMessage.value = '';
  toggleError.value = '';
  try {
    const enabled = !(cryptoMode.value?.enabled ?? false);
    cryptoMode.value = await apiFetch<CryptoModeSetting>('/settings/crypto-trading-mode', {
      method: 'PUT',
      body: { enabled },
    });
    toggleMessage.value = `Crypto trading mode ${enabled ? 'enabled' : 'disabled'}.`;
    await loadSettings();
  } catch (err) {
    toggleError.value = err instanceof Error && err.message
      ? `Crypto trading mode update failed: ${err.message}`
      : 'Crypto trading mode update failed. Please try again.';
  } finally {
    toggleBusy.value = false;
  }
}

async function analyze() {
  analysisBusy.value = true;
  analysisError.value = '';
  result.value = null;
  try {
    result.value = await apiFetch<AnalysisResponse>(`/crypto/analysis/${encodeURIComponent(form.symbol)}`);
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
    const decisionResult = await apiFetch<CryptoDecisionResult>('/signals/crypto-decision', {
      method: 'POST',
      body: { symbol: form.symbol },
    });
    if (decisionResult.proposal) {
      createdProposalId.value = decisionResult.proposal.id;
      submitMessage.value = `Crypto ${decisionResult.analysis.decision} proposal created. Status: ${decisionResult.proposal.status}.`;
    } else {
      submitMessage.value = 'Decision is HOLD — no proposal was created.';
    }
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Failed to submit crypto decision.';
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
function snapshotNumber(key: string): number | null {
  const value = result.value?.sizingPreview?.snapshot[key];
  return typeof value === 'number' ? value : null;
}
function tradeCounts(): TradeCountsSnapshot | null {
  const value = result.value?.sizingPreview?.snapshot.tradeCounts;
  return value && typeof value === 'object' ? value as TradeCountsSnapshot : null;
}
function cooldownSnapshot(): CooldownSnapshot | null {
  const value = result.value?.sizingPreview?.snapshot.cooldown;
  return value && typeof value === 'object' ? value as CooldownSnapshot : null;
}
function failedRules(): string[] {
  return result.value?.sizingPreview?.failedRules ?? [];
}
function money(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}
function maybeMoney(value: string | null | undefined): string {
  return value ? money(value) : '-';
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
function dailyLossStatus(): string {
  const used = snapshotString('dailyLossUsed');
  const cryptoLimit = snapshotString('cryptoDailyLossLimit');
  const platformLimit = snapshotString('platformDailyLossLimit');
  const status = failedRules().some((rule) => rule.includes('MAX_DAILY_LOSS')) ? 'BLOCKED' : 'PASS';
  return `${status} (${used ? money(used) : '$0.00'} / ${cryptoLimit ? money(cryptoLimit) : '-'} / ${platformLimit ? money(platformLimit) : '-'})`;
}
function dailyLossPercent(): number {
  const used = Number(snapshotString('dailyLossUsed') ?? 0);
  const limit = Number(snapshotString('cryptoDailyLossLimit') ?? 0);
  return limit > 0 ? (used / limit) * 100 : 0;
}
function pendingOrderStatus(): string {
  const value = result.value?.sizingPreview?.snapshot.conflictingPendingOrders;
  const count = Array.isArray(value) ? value.length : 0;
  return count > 0 ? `BLOCKED (${count})` : 'CLEAR';
}
</script>
