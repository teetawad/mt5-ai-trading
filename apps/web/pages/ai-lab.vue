<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">CHAMPION / CHALLENGER</p>
      <h1 class="page-title">AI Lab</h1>
      <p class="page-subtitle">No online self-modifying AI. Challengers must pass chronological validation, out-of-sample tests, walk-forward evaluation, and explicit manual promotion gates.</p>
    </div>

    <UiCard title="Diagnostics" subtitle="Server-side provider status only — API keys are never sent to the browser, shown here, or logged.">
      <div class="grid gap-3 md:grid-cols-3">
        <InfoTile label="Trading AI Provider" :value="providerLabel" />
        <InfoTile label="Model" :value="aiStatus?.model ?? '-'" />
        <InfoTile label="Configured" :value="aiStatus?.configured ? 'YES' : 'NO'" :tone="aiStatus?.configured ? 'gain' : 'loss'" />
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-3">
        <InfoTile label="MT5 Connected" :value="mt5Status?.connected ? 'YES' : 'NO'" :tone="mt5Status?.connected ? 'gain' : 'loss'" />
        <InfoTile label="MT5 DEMO Verified" :value="mt5Status?.demo_verified ? 'YES' : 'NO'" :tone="mt5Status?.demo_verified ? 'gain' : 'loss'" />
        <InfoTile label="Blocked Reason" :value="mt5Status?.blocked_reason ?? 'none'" />
      </div>
    </UiCard>

    <UiCard title="V3 Architecture" subtitle="The trading-specialist AI is the primary user-facing brain. The deterministic baseline remains only as a benchmark.">
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-lg border border-emerald-400/40 bg-emerald-400/5 p-4">
          <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Primary — Champion</p>
          <p class="mt-1 text-lg font-semibold text-white">TRADING_AI_V3_PROMPT_001</p>
          <p class="mt-1 text-xs text-slate-400">Provider/model come from TRADING_AI_PROVIDER / TRADING_AI_MODEL. Used by /ai-trade.</p>
          <NuxtLink to="/ai-trade" class="btn-success mt-3 inline-block">Open AI Trade</NuxtLink>
        </div>
        <div class="rounded-lg border border-slate-700 bg-slate-950/70 p-4">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-400">Benchmark — Baseline</p>
          <p class="mt-1 text-lg font-semibold text-white">BASELINE_MT5_H1_V1</p>
          <p class="mt-1 text-xs text-slate-400">Deterministic H1 strategy. Kept running only for comparison/research, never the primary AI.</p>
          <NuxtLink to="/analysis" class="btn-primary mt-3 inline-block">Open Baseline Analysis</NuxtLink>
        </div>
      </div>
    </UiCard>

    <UiCard title="Trade Score Calibration" subtitle="Evidence, not automatic tuning: how each Trade Score bucket actually performed in real DEMO outcomes. The scoring formula is never changed automatically from this data.">
      <div v-if="buckets.length && totalSampleSize > 0" class="overflow-x-auto">
        <table class="w-full min-w-[520px] text-left text-sm text-slate-300">
          <thead class="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-2 pr-4">Score bucket</th>
              <th class="py-2 pr-4">Trades</th>
              <th class="py-2 pr-4">Win rate</th>
              <th class="py-2 pr-4">Profit factor</th>
              <th class="py-2 pr-4">Average R</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bucket in buckets" :key="bucket.bucket" class="border-t border-slate-800">
              <td class="py-2 pr-4 font-semibold text-white">{{ bucket.bucket }}</td>
              <td class="py-2 pr-4">{{ bucket.trades }}</td>
              <td class="py-2 pr-4">{{ bucket.trades ? `${Math.round(bucket.winRate * 100)}%` : '-' }}</td>
              <td class="py-2 pr-4">{{ bucket.profitFactor === null ? '-' : bucket.profitFactor.toFixed(2) }}</td>
              <td class="py-2 pr-4">{{ bucket.averageR === null ? '-' : bucket.averageR.toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-3 text-xs text-slate-500">Sample size: {{ totalSampleSize }} closed DEMO trades with a recorded Trade Score. Small buckets are not statistically meaningful yet.</p>
      </div>
      <EmptyState v-else title="No scored trades closed yet" message="Once AI V3 DEMO trades close, this table will compare each Trade Score bucket against its actual win rate and profit factor." />
    </UiCard>

    <div class="grid gap-4 lg:grid-cols-3">
      <UiCard title="Challengers"><p class="text-sm text-slate-300">Offline candidates only (alternate prompt versions or providers). No immediate deployment — promotion is always a manual, explicit action.</p></UiCard>
      <UiCard title="Promotion Gate"><p class="text-sm text-slate-300">Net P&L, expectancy, profit factor, drawdown, win rate, average R, and sample size, compared over real DEMO outcomes recorded in ai_analysis_runs/ai_trade_plans.</p></UiCard>
      <UiCard title="Learning Dataset"><p class="text-sm text-slate-300">Every AI analysis — including WAIT decisions — is stored with its market analysis package, chart references, raw AI response, and eventual trade outcome. Data collection and evaluation are not the same as model training.</p></UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
type Bucket = { bucket: string; trades: number; wins: number; losses: number; winRate: number; profitFactor: number | null; averageR: number | null };
type AiStatus = { provider: string | null; model: string | null; configured: boolean };
type Mt5Status = { connected: boolean; demo_verified: boolean; blocked_reason: string | null };

const { apiFetch } = useApi();
const { data } = await useAsyncData<{ buckets: Bucket[]; totalSampleSize: number }>('ai-lab-score-evaluation', () => apiFetch('/mt5/ai-trade/score-evaluation'), { lazy: true });
const { data: aiStatus } = await useAsyncData<AiStatus>('ai-lab-provider-status', () => apiFetch('/mt5/ai-trade/status'), { lazy: true });
const { data: mt5Status } = await useAsyncData<Mt5Status>('ai-lab-mt5-status', () => apiFetch('/mt5/status'), { lazy: true });
const buckets = computed(() => data.value?.buckets ?? []);
const totalSampleSize = computed(() => data.value?.totalSampleSize ?? 0);
const providerLabel = computed(() => {
  const provider = aiStatus.value?.provider;
  if (!provider) return 'NOT CONFIGURED';
  return provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : provider;
});
</script>
