<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">MT5 DEMO ONLY</p>
        <h1 class="page-title">MT5 AI Demo Trading Lab</h1>
        <p class="page-subtitle">Server-side MT5 DEMO verification, hourly baseline analysis, risk controls, scanner state, and AUTO-DEMO status.</p>
      </div>
      <div class="flex gap-2">
        <button class="btn-primary" :disabled="refreshing" @click="refreshAll">{{ refreshing ? 'Refreshing...' : 'Refresh' }}</button>
        <button class="btn-success" :disabled="busy" @click="syncInstruments">Sync Instruments</button>
      </div>
    </div>

    <div v-if="error" class="notice-error">{{ error.message }}</div>
    <div v-if="message" class="notice-info">{{ message }}</div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox label="MT5 Connection" :value="scanner?.status.connected ? 'CONNECTED' : 'DISCONNECTED'" :class-name="scanner?.status.connected ? 'text-emerald-300' : 'text-rose-300'" />
      <MetricBox label="Demo Guard" :value="scanner?.status.demo_verified ? 'DEMO VERIFIED' : 'BLOCKED'" :class-name="scanner?.status.demo_verified ? 'text-emerald-300' : 'text-rose-300'" />
      <MetricBox label="AUTO-DEMO" :value="scanner?.autoDemoEnabled ? 'ENABLED' : 'OFF'" :class-name="scanner?.autoDemoEnabled ? 'text-amber-200' : 'text-slate-300'" />
      <MetricBox label="Scanner Rows" :value="String(scanner?.scanner.length ?? 0)" />
    </div>

    <div v-if="scanner?.status.blocked_reason" class="notice-warn">
      {{ scanner.status.blocked_reason }}
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <UiCard title="Account" subtitle="Never sent to the frontend with credentials.">
        <dl class="grid gap-3 text-sm">
          <div class="flex justify-between"><dt class="text-slate-400">Login</dt><dd>{{ account.login ?? '-' }}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Server</dt><dd>{{ account.server ?? '-' }}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Balance</dt><dd>{{ account.balance ?? '-' }}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Equity</dt><dd>{{ account.equity ?? '-' }}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Free Margin</dt><dd>{{ account.margin_free ?? account.free_margin ?? '-' }}</dd></div>
        </dl>
      </UiCard>
      <UiCard title="Risk Engine" subtitle="AI confidence cannot override these checks.">
        <dl class="grid gap-3 text-sm">
          <div class="flex justify-between"><dt class="text-slate-400">Kill Switch</dt><dd>SERVER ENFORCED</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Stop Loss</dt><dd>MANDATORY</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Take Profit</dt><dd>MANDATORY</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Order Path</dt><dd>DemoExecutionGateway</dd></div>
        </dl>
      </UiCard>
      <UiCard title="Hourly Scheduler" subtitle="Browser is not required.">
        <dl class="grid gap-3 text-sm">
          <div class="flex justify-between"><dt class="text-slate-400">Primary TF</dt><dd>Completed H1 candle</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Model</dt><dd>BASELINE_MT5_H1_V1</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">Duplicate Guard</dt><dd>DB unique candle key</dd></div>
          <div class="flex justify-between"><dt class="text-slate-400">AUTO-DEMO Default</dt><dd>OFF</dd></div>
        </dl>
      </UiCard>
    </div>

    <UiCard title="Market Scanner" subtitle="Owner-enabled MT5 instruments only. BUY/SELL are proposals until risk and execution gates pass." body-class="p-0">
      <DataTable :empty="!(scanner?.scanner.length)" empty-label="No enabled watchlist symbols. Sync instruments and enable a watchlist row in PostgreSQL." :columns="['Rank','Symbol','Class','Decision','Confidence','Score','Entry','SL','TP','R:R','Risk']">
        <tr v-for="row in scanner?.scanner ?? []" :key="row.symbol" class="border-t border-slate-800/80 hover:bg-slate-800/40">
          <td class="px-4 py-3">{{ row.rank }}</td>
          <td class="px-4 py-3 font-semibold text-white">{{ row.symbol }}</td>
          <td class="px-4 py-3"><StatusPill :label="row.assetClass" /></td>
          <td class="px-4 py-3"><StatusPill :label="row.decision" /></td>
          <td class="px-4 py-3 tabular-nums">{{ percent(row.confidence) }}</td>
          <td class="px-4 py-3 tabular-nums">{{ row.opportunity_score }}</td>
          <td class="px-4 py-3 tabular-nums">{{ row.reference_entry }}</td>
          <td class="px-4 py-3 tabular-nums text-rose-200">{{ row.stop_loss ?? '-' }}</td>
          <td class="px-4 py-3 tabular-nums text-emerald-200">{{ row.take_profit ?? '-' }}</td>
          <td class="px-4 py-3 tabular-nums">{{ row.risk_reward ?? '-' }}</td>
          <td class="px-4 py-3"><StatusPill :label="row.risk.result" /></td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type ScannerRow = {
  rank: number;
  symbol: string;
  assetClass: string;
  decision: string;
  confidence: number;
  opportunity_score: number;
  reference_entry: string;
  stop_loss: string | null;
  take_profit: string | null;
  risk_reward: string | null;
  risk: { result: string; failedRules: string[] };
};
type ScannerResponse = {
  status: { connected: boolean; demo_verified: boolean; blocked_reason?: string | null; account?: Record<string, unknown> | null };
  autoDemoEnabled: boolean;
  scanner: ScannerRow[];
};

const { apiFetch } = useApi();
const refreshing = ref(false);
const busy = ref(false);
const message = ref('');
const { data: scanner, error, refresh } = await useAsyncData<ScannerResponse>('mt5-scanner-dashboard', () => apiFetch('/mt5/scanner'));
useAutoRefresh(refresh, 5000);

const account = computed(() => scanner.value?.status.account ?? {});

async function refreshAll() {
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}

async function syncInstruments() {
  busy.value = true;
  message.value = '';
  try {
    const result = await apiFetch<{ imported: number }>('/mt5/sync-instruments', { method: 'POST' });
    message.value = `Imported or refreshed ${result.imported} MT5 instruments.`;
    await refresh();
  } finally {
    busy.value = false;
  }
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}
</script>
