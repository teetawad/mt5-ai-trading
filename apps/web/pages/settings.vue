<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Paper trading controls and risk parameters. No live trading controls are exposed.</p>
    </div>
    <div
      v-if="message"
      class="notice-info"
    >
      {{ message }}
    </div>
    <div
      v-if="actionError"
      class="notice-error"
    >
      {{ actionError }}
    </div>
    <section class="rounded-lg border border-slate-800 bg-slate-900/70 p-4 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="font-semibold text-white">Kill Switch</h2>
          <p class="mt-1 text-sm text-slate-400">Controls whether paper trading approvals and execution remain active.</p>
          <div class="mt-3"><StatusPill :label="killSwitch?.enabled ? 'PAPER ENABLED' : 'PAPER DISABLED'" /></div>
        </div>
        <button
          class="rounded-lg border px-4 py-2 text-sm font-semibold transition"
          :class="killSwitch?.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
          @click="toggleKillSwitch"
        >
          {{ killSwitch?.enabled ? 'Disable' : 'Enable' }}
        </button>
      </div>
    </section>
    <UiCard
      title="System Settings"
      subtitle="Current paper trading and risk configuration."
      body-class="p-0"
    >
      <dl class="divide-y divide-slate-800">
        <div
          v-for="setting in settings ?? []"
          :key="setting.key"
          class="grid gap-1 px-4 py-3 md:grid-cols-3"
        >
          <dt class="text-sm text-slate-400">{{ setting.key }}</dt>
          <dd class="text-sm font-semibold text-slate-100 md:col-span-1">
            {{ setting.value }}
            <span
              v-if="percentLabel(setting.key, setting.value)"
              class="ml-1 font-normal text-slate-500"
            >({{ percentLabel(setting.key, setting.value) }})</span>
          </dd>
          <dd class="text-sm text-slate-500">{{ setting.description ?? '-' }}</dd>
        </div>
      </dl>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type Setting = { key: string; value: unknown; description: string | null };
type KillSwitch = { enabled: boolean };
const { apiFetch } = useApi();
const message = ref('');
const actionError = ref('');
const { data: settings, refresh: refreshSettings } = await useAsyncData<Setting[]>('settings-page', () => apiFetch('/settings'));
const { data: killSwitch, refresh: refreshKillSwitch } = await useAsyncData<KillSwitch>('settings-kill-switch-page', () => apiFetch('/settings/kill-switch'));

// max_portfolio_concentration_pct / price_drift_threshold_pct are stored as
// a 0-1 FRACTION (0.20 = 20%); phase22_* thresholds are stored as a
// whole-number percent (0.5 = 0.5%) — two conventions coexist in
// system_settings (see docs/RISK_ENGINE.md), so the raw value alone is
// ambiguous without knowing which bucket a key falls in.
const FRACTION_PERCENT_KEYS = new Set(['max_portfolio_concentration_pct', 'price_drift_threshold_pct']);
const WHOLE_PERCENT_KEYS = new Set([
  'phase22_stop_loss_pct',
  'phase22_take_profit_pct',
  'phase22_max_bid_ask_spread_pct',
  'phase22_estimated_slippage_pct',
  'phase22_max_estimated_slippage_pct',
]);

function percentLabel(key: string, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  if (FRACTION_PERCENT_KEYS.has(key)) return `${(parsed * 100).toFixed(2)}%`;
  if (WHOLE_PERCENT_KEYS.has(key)) return `${parsed.toFixed(2)}%`;
  return '';
}

async function toggleKillSwitch() {
  const enabled = !(killSwitch.value?.enabled ?? true);
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch('/settings/kill-switch', { method: 'PUT', body: { enabled } });
    message.value = `Kill switch ${enabled ? 'enabled' : 'disabled'}.`;
    await Promise.all([refreshSettings(), refreshKillSwitch()]);
  } catch (err) {
    actionError.value = err instanceof Error && err.message
      ? `Kill switch update failed: ${err.message}`
      : 'Kill switch update failed. Please try again.';
  }
}
</script>
