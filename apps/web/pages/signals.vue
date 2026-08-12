<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Strategy Signals</h1>
      <p class="page-subtitle">Signals emitted by strategies before proposal creation. AI analysis and Risk Engine decisions remain visually separate.</p>
    </div>

    <section class="rounded-lg border border-emerald-400/40 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-emerald-300">AI ASSISTED ANALYSIS / PAPER ONLY</div>
          <h2 class="mt-1 text-lg font-semibold">AI Assisted Analysis</h2>
        </div>
        <StatusPill label="OWNER APPROVAL REQUIRED" />
      </div>

      <form
        class="mt-4 grid gap-3 md:grid-cols-[1.2fr_0.8fr_0.8fr_auto]"
        @submit.prevent="analyzeWithAi"
      >
        <label class="block">
          <span class="text-xs uppercase text-slate-500">US stock symbol</span>
          <select
            v-model="aiForm.symbol"
            class="field-input"
            required
          >
            <option
              v-for="symbol in options?.symbols ?? []"
              :key="symbol"
              :value="symbol"
            >
              {{ symbol }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Decision mode</span>
          <select
            v-model="aiForm.side"
            class="field-input"
          >
            <option value="AUTO">AUTO</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
            <option value="HOLD">HOLD</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Max quantity</span>
          <input
            v-model="aiForm.quantity"
            class="field-input"
            inputmode="decimal"
            pattern="^\d+(\.\d+)?$"
            required
          >
        </label>
        <button
          class="mt-5 rounded-lg border border-emerald-400/50 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-400/20 disabled:opacity-40"
          :disabled="aiBusy || !(options?.symbols?.length)"
          type="submit"
        >
          Analyze with AI
        </button>
      </form>

      <div
        v-if="aiError"
        class="notice-error mt-4"
      >
        {{ aiError }}
      </div>

      <div class="mt-4 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <MiniLineChart
          title="Selected Symbol Sparkline"
          :points="priceSparkline"
          :value-label="sparklineLabel"
          tone="sky"
        />
        <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Analysis Flow</p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3">
              <p class="text-xs font-bold uppercase tracking-widest text-emerald-300">AI Decision</p>
              <p class="mt-2 text-sm text-slate-300">Model analysis can suggest BUY, SELL, or HOLD.</p>
            </div>
            <div class="rounded-lg border border-sky-400/30 bg-sky-400/10 p-3">
              <p class="text-xs font-bold uppercase tracking-widest text-sky-300">Risk Engine Decision</p>
              <p class="mt-2 text-sm text-slate-300">Rules decide whether a proposal can proceed to owner approval.</p>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="aiResult && aiResult.aiDecision"
        class="mt-4 grid gap-4 lg:grid-cols-2"
      >
        <div class="rounded-lg border border-emerald-400/30 bg-slate-950/70 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-emerald-300">AI Decision</div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <StatusPill :label="aiResult.aiDecision.decision" />
                <span class="text-sm text-slate-300">Confidence {{ percent(aiResult.aiDecision.confidence) }}</span>
              </div>
            </div>
            <div class="text-right text-xs text-slate-500">
              <div>{{ aiResult.aiDecision.model }}</div>
              <div>{{ aiResult.aiDecision.strategyVersion }}</div>
            </div>
          </div>

          <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs uppercase text-slate-500">Trend</dt>
              <dd class="mt-1 text-slate-100">{{ aiResult.aiDecision.trend }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Momentum</dt>
              <dd class="mt-1 text-slate-100">{{ aiResult.aiDecision.momentum }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Volatility</dt>
              <dd class="mt-1 text-slate-100">{{ aiResult.aiDecision.volatility }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Volume</dt>
              <dd class="mt-1 text-slate-100">{{ numberText(aiResult.aiDecision.volume) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Suggested entry</dt>
              <dd class="mt-1 text-slate-100">{{ money(aiResult.aiDecision.proposedEntry) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Calculated position size</dt>
              <dd class="mt-1 text-slate-100">{{ quantityText(aiResult.aiDecision.suggestedPositionSize) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Stop loss</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(aiResult.aiDecision.stopLoss) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Take profit</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(aiResult.aiDecision.takeProfit) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Risk/reward</dt>
              <dd class="mt-1 text-slate-100">{{ ratioText(aiResult.aiDecision.riskReward) }}</dd>
            </div>
          </dl>

          <div class="mt-4">
            <div class="text-xs uppercase text-slate-500">Analysis reasons</div>
            <ul class="mt-2 space-y-2 text-sm text-slate-300">
              <li
                v-for="reason in aiReasons(aiResult)"
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
              <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">Risk Engine Decision</div>
              <div class="mt-2">
                <StatusPill :label="riskDecision(aiResult)" />
              </div>
            </div>
            <StatusPill :label="aiResult.proposal?.status ?? 'NO_PROPOSAL'" />
          </div>

          <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs uppercase text-slate-500">Entry</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(phase22(aiResult)?.entry ?? aiResult.proposal?.referencePrice ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Quantity</dt>
              <dd class="mt-1 text-slate-100">{{ quantityText(phase22(aiResult)?.quantity ?? aiResult.proposal?.quantity ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Stop loss</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(phase22(aiResult)?.stopLoss ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Take profit</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(phase22(aiResult)?.takeProfit ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Max loss</dt>
              <dd class="mt-1 text-slate-100">{{ maybeMoney(phase22(aiResult)?.maxLoss ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Risk/reward</dt>
              <dd class="mt-1 text-slate-100">{{ ratioText(phase22(aiResult)?.riskReward ?? null) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Spread/slippage</dt>
              <dd class="mt-1 text-slate-100">{{ spreadSlippage(aiResult) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Cooldown status</dt>
              <dd class="mt-1 text-slate-100">{{ cooldownStatus(aiResult) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Daily loss status</dt>
              <dd class="mt-1 text-slate-100">{{ dailyLossStatus(aiResult) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase text-slate-500">Pending-order status</dt>
              <dd class="mt-1 text-slate-100">{{ pendingOrderStatus(aiResult) }}</dd>
            </div>
          </dl>

          <div class="mt-4">
            <ProgressMeter
              label="Daily Loss Used vs Limit"
              :percent="dailyLossPercent(aiResult)"
              :value-label="dailyLossStatus(aiResult)"
              :status-label="riskDecision(aiResult)"
              helper="Uses Phase 22 risk snapshot fields when present."
            />
          </div>

          <div
            v-if="aiResult.proposal"
            class="mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100"
          >
            Proposal {{ aiResult.proposal.status }}.
            <NuxtLink
              class="ml-2 font-semibold underline"
              :to="`/proposals?proposalId=${aiResult.proposal.id}`"
            >
              Open generated proposal
            </NuxtLink>
          </div>
          <div
            v-else
            class="mt-4 rounded border border-slate-700 bg-slate-900 p-3 text-sm text-slate-300"
          >
            No trade proposal created.
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-lg border border-sky-400/40 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">MANUAL TEST / PAPER ONLY</div>
          <h2 class="mt-1 text-lg font-semibold">Create Paper Test Signal</h2>
        </div>
        <StatusPill label="PAPER ONLY" />
      </div>

      <form
        class="mt-4 grid gap-3 md:grid-cols-[1.2fr_0.8fr_0.8fr_auto]"
        @submit.prevent="createManualSignal"
      >
        <label class="block">
          <span class="text-xs uppercase text-slate-500">US stock symbol</span>
          <select
            v-model="form.symbol"
            class="field-input"
            required
          >
            <option
              v-for="symbol in options?.symbols ?? []"
              :key="symbol"
              :value="symbol"
            >
              {{ symbol }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Side</span>
          <select
            v-model="form.side"
            class="field-input"
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Quantity</span>
          <input
            v-model="form.quantity"
            class="field-input"
            inputmode="decimal"
            pattern="^\d+(\.\d+)?$"
            required
          >
        </label>
        <button
          class="btn-primary mt-5"
          :disabled="busy || !(options?.symbols?.length)"
          type="submit"
        >
          Create
        </button>
      </form>

      <div
        v-if="message"
        class="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100"
      >
        {{ message }}
        <NuxtLink
          v-if="createdProposalId"
          class="ml-2 font-semibold underline"
          :to="`/proposals?proposalId=${createdProposalId}`"
        >
          Open generated proposal
        </NuxtLink>
      </div>
      <div
        v-if="submitError"
        class="notice-error mt-4"
      >
        {{ submitError }}
      </div>
    </section>

    <UiCard
      title="Recent Signals"
      body-class="p-0"
    >
      <DataTable
        :empty="!(data?.signals?.length)"
        empty-label="No signals"
        :columns="['Symbol', 'Side', 'Reference', 'Confidence', 'Status', 'Created']"
      >
        <tr
          v-for="signal in data?.signals ?? []"
          :key="signal.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 font-semibold text-white">{{ signal.symbol }}</td>
          <td class="px-4 py-3">{{ signal.side }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(signal.referencePrice) }}</td>
          <td class="px-4 py-3 tabular-nums">{{ signal.confidence ?? '-' }}</td>
          <td class="px-4 py-3"><StatusPill :label="signal.status" /></td>
          <td class="px-4 py-3 text-slate-400">{{ date(signal.createdAt) }}</td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type Signal = {
  id: string;
  symbol: string;
  side: string;
  referencePrice: string;
  confidence: string | null;
  status: string;
  createdAt: string;
};
type ManualOptions = {
  symbols: string[];
};
type MarketBar = { close: string; timestamp: string };
type ManualSignalResult = {
  signal: Signal;
  proposal: {
    id: string;
    status: string;
    referencePrice: string;
  };
};
type AiDecision = {
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: string;
  reasons: string[];
  model: string;
  strategyVersion: string;
  trend: string;
  momentum: string;
  volatility: string;
  volume: string;
  proposedEntry: string;
  stopLoss: string | null;
  takeProfit: string | null;
  riskReward: string | null;
  suggestedPositionSize: string;
};
type Phase22Risk = {
  entry?: string;
  stopLoss?: string;
  takeProfit?: string;
  riskReward?: string;
  quantity?: string;
  maxLoss?: string;
  spreadPct?: string;
  estimatedSlippagePct?: string;
  dailyLossUsed?: string;
  dailyLossLimit?: string;
  cooldown?: {
    configuredSeconds?: number;
    remainingSeconds?: number;
    passed?: boolean;
  };
  conflictingPendingOrders?: unknown[];
  failedRules?: string[];
  result?: string;
};
type AiDecisionResult = {
  aiDecision: AiDecision;
  signal: Signal | null;
  riskCheck: {
    result: string;
    failedRules: string[];
  } | null;
  riskResult: {
    result: string;
    failed_rules: string[];
    reason: string | null;
    phase22?: Phase22Risk;
  } | null;
  proposal: {
    id: string;
    status: string;
    referencePrice: string;
    quantity: string;
    riskSnapshot?: {
      result?: string;
      phase22?: Phase22Risk;
    };
  } | null;
};
const { apiFetch } = useApi();
const busy = ref(false);
const aiBusy = ref(false);
const message = ref('');
const submitError = ref('');
const aiError = ref('');
const createdProposalId = ref('');
const aiResult = ref<AiDecisionResult | null>(null);
const priceBars = ref<MarketBar[]>([]);
const form = reactive({
  symbol: '',
  side: 'BUY' as 'BUY' | 'SELL',
  quantity: '1',
});
const aiForm = reactive({
  symbol: '',
  side: 'AUTO' as 'AUTO' | 'BUY' | 'SELL' | 'HOLD',
  quantity: '1',
});
const { data: options } = await useAsyncData<ManualOptions>('manual-test-signal-options', () => apiFetch('/signals/manual-test/options'));
const { data, refresh } = await useAsyncData<{ signals: Signal[] }>('signals-page', () => apiFetch('/signals?limit=50'));

watchEffect(() => {
  if (!form.symbol && options.value?.symbols?.length) {
    form.symbol = options.value.symbols[0];
  }
  if (!aiForm.symbol && options.value?.symbols?.length) {
    aiForm.symbol = options.value.symbols[0];
  }
});

watch(() => aiForm.symbol, async (symbol) => {
  if (!symbol) {
    priceBars.value = [];
    return;
  }
  await loadSparkline(symbol);
}, { immediate: true });

const priceSparkline = computed(() => priceBars.value.map((bar) => ({ label: bar.timestamp, value: numberValue(bar.close) })));
const sparklineLabel = computed(() => {
  const latest = priceBars.value.at(-1);
  return latest ? money(latest.close) : `${aiForm.symbol || 'Symbol'} history unavailable`;
});

async function loadSparkline(symbol: string) {
  const start = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  try {
    priceBars.value = await apiFetch<MarketBar[]>(`/market-data/bars/${symbol}?timeframe=1Day&start=${encodeURIComponent(start)}&limit=30`);
  } catch {
    priceBars.value = [];
  }
}

async function analyzeWithAi() {
  aiBusy.value = true;
  aiError.value = '';
  aiResult.value = null;
  try {
    const body: Record<string, string> = {
      symbol: aiForm.symbol,
      quantity: aiForm.quantity,
    };
    if (aiForm.side !== 'AUTO') {
      body.side = aiForm.side;
    }
    aiResult.value = await apiFetch<AiDecisionResult>('/signals/ai-decision', {
      method: 'POST',
      body,
    });
    await refresh();
  } catch (err) {
    aiError.value = err instanceof Error ? err.message : 'Failed to run AI-assisted PAPER analysis.';
  } finally {
    aiBusy.value = false;
  }
}

async function createManualSignal() {
  busy.value = true;
  message.value = '';
  submitError.value = '';
  createdProposalId.value = '';
  try {
    const result = await apiFetch<ManualSignalResult>('/signals/manual-test', {
      method: 'POST',
      body: {
        symbol: form.symbol,
        side: form.side,
        quantity: form.quantity,
      },
    });
    createdProposalId.value = result.proposal.id;
    message.value = `Manual PAPER test signal created at ${money(result.proposal.referencePrice)}. Proposal status: ${result.proposal.status}.`;
    await refresh();
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Failed to create manual PAPER test signal.';
  } finally {
    busy.value = false;
  }
}

function money(value: string): string {
  return `$${numberValue(value).toFixed(2)}`;
}
function maybeMoney(value: string | null | undefined): string {
  return value ? money(value) : '-';
}
function percent(value: string | null | undefined): string {
  if (!value) return '-';
  return `${(Number(value) * 100).toFixed(1)}%`;
}
function ratioText(value: string | null | undefined): string {
  if (!value) return '-';
  return Number(value).toFixed(2);
}
function quantityText(value: string | null | undefined): string {
  if (!value) return '-';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
function numberText(value: string | null | undefined): string {
  if (!value) return '-';
  return Number(value).toLocaleString();
}
function aiReasons(result: AiDecisionResult | null): string[] {
  const reasons = result?.aiDecision?.reasons;
  return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string') : [];
}
function phase22(result: AiDecisionResult | null): Phase22Risk | null {
  return result?.proposal?.riskSnapshot?.phase22 ?? result?.riskResult?.phase22 ?? null;
}
function failedRules(result: AiDecisionResult): string[] {
  return [
    ...(result.riskResult?.failed_rules ?? []),
    ...(result.riskCheck?.failedRules ?? []),
    ...(phase22(result)?.failedRules ?? []),
  ];
}
function riskDecision(result: AiDecisionResult): string {
  return result.proposal?.riskSnapshot?.result ?? result.riskResult?.result ?? result.riskCheck?.result ?? 'HOLD';
}
function spreadSlippage(result: AiDecisionResult): string {
  const risk = phase22(result);
  if (!risk) return '-';
  const spread = risk.spreadPct ? `${Number(risk.spreadPct).toFixed(3)}% spread` : '-';
  const slippage = risk.estimatedSlippagePct ? `${Number(risk.estimatedSlippagePct).toFixed(3)}% slippage` : '-';
  return `${spread} / ${slippage}`;
}
function cooldownStatus(result: AiDecisionResult): string {
  const cooldown = phase22(result)?.cooldown;
  if (!cooldown) return '-';
  if (cooldown.passed) return 'PASS';
  return `BLOCKED (${cooldown.remainingSeconds ?? 0}s remaining)`;
}
function dailyLossStatus(result: AiDecisionResult): string {
  const risk = phase22(result);
  if (!risk) return '-';
  const status = failedRules(result).includes('PHASE22_MAX_DAILY_LOSS') ? 'BLOCKED' : 'PASS';
  const used = risk.dailyLossUsed ? money(risk.dailyLossUsed) : '$0.00';
  const limit = risk.dailyLossLimit ? money(risk.dailyLossLimit) : '-';
  return `${status} (${used} / ${limit})`;
}
function pendingOrderStatus(result: AiDecisionResult): string {
  const risk = phase22(result);
  if (!risk) return '-';
  const count = risk.conflictingPendingOrders?.length ?? 0;
  return count > 0 ? `BLOCKED (${count})` : 'CLEAR';
}
function dailyLossPercent(result: AiDecisionResult): number {
  const risk = phase22(result);
  const used = numberValue(risk?.dailyLossUsed);
  const limit = numberValue(risk?.dailyLossLimit);
  return limit > 0 ? (used / limit) * 100 : 0;
}
function numberValue(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
