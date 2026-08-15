<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">AI DECISION / RISK DECISION SEPARATED</p>
      <h1 class="page-title">AI Analysis</h1>
      <p class="page-subtitle">Runs the deterministic BASELINE H1 strategy and stores the feature snapshot. It does not execute trades.</p>
    </div>
    <div class="flex max-w-xl gap-2">
      <input v-model="symbol" class="field-input" placeholder="Broker symbol, e.g. EURUSD or XAUUSD" @keyup.enter="runAnalysis">
      <button class="btn-primary mt-1" :disabled="busy" @click="runAnalysis">{{ busy ? 'Running...' : 'Analyze' }}</button>
    </div>
    <div v-if="error" class="notice-error">{{ error }}</div>
    <UiCard v-if="decision" title="AI Decision" subtitle="BASELINE deterministic strategy, not a trained ML model.">
      <div class="grid gap-3 md:grid-cols-4">
        <MetricBox label="Decision" :value="decision.decision" />
        <MetricBox label="Confidence" :value="`${Math.round(Number(decision.confidence) * 100)}%`" />
        <MetricBox label="Score" :value="String(decision.opportunity_score)" />
        <MetricBox label="Model" :value="decision.model_version" />
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-4">
        <MetricBox label="Reference Entry" :value="decision.reference_entry ?? '-'" />
        <MetricBox label="Stop Loss" :value="decision.stop_loss ?? '-'" />
        <MetricBox label="Take Profit" :value="decision.take_profit ?? '-'" />
        <MetricBox label="R:R" :value="decision.risk_reward ?? '-'" />
      </div>
      <ul class="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-300">
        <li v-for="reason in decision.reasons" :key="reason">{{ reason }}</li>
      </ul>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
const { apiFetch } = useApi();
const symbol = ref('');
const busy = ref(false);
const error = ref('');
const decision = ref<Record<string, any> | null>(null);

async function runAnalysis() {
  if (!symbol.value.trim()) return;
  busy.value = true;
  error.value = '';
  decision.value = null;
  try {
    const result = await apiFetch<{ decision: Record<string, any> }>(`/mt5/analysis/${encodeURIComponent(symbol.value.trim())}`, { method: 'POST' });
    decision.value = result.decision;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Analysis failed';
  } finally {
    busy.value = false;
  }
}
</script>
