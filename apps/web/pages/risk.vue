<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Risk</h1>
      <p class="page-subtitle">Current rule settings, recent Risk Engine decisions, daily loss usage, cooldown configuration, and pending paper order status.</p>
    </div>

    <div
      v-if="settingsError || checksError || portfolioError || dashboardError"
      class="notice-error"
    >
      Some risk data failed to load. Available panels still use the existing successful API responses.
    </div>

    <div class="grid gap-4 xl:grid-cols-4">
      <ProgressMeter
        label="Daily Loss Used vs Limit"
        :percent="dailyLossPercent"
        :value-label="`${money(dailyLossUsed)} / ${money(maxDailyLoss)}`"
        :status-label="dailyLossPercent >= 100 ? 'BLOCKED' : 'PASS'"
        helper="Uses absolute negative daily P&L from the internal ledger."
      />
      <ProgressMeter
        label="Cooldown Status"
        :percent="cooldownConfiguredPercent"
        :value-label="cooldownLabel"
        status-label="CONFIGURED"
        helper="Current page exposes configured cooldown; live remaining cooldown is available in proposal risk snapshots."
      />
      <ProgressMeter
        label="Pending Orders"
        :percent="pendingOrderPercent"
        :value-label="`${dashboard?.reconciliation.pendingOrderCount ?? 0} pending`"
        :status-label="(dashboard?.reconciliation.pendingOrderCount ?? 0) > 0 ? 'PENDING' : 'CLEAR'"
        helper="Alpaca paper open orders from the dashboard endpoint."
      />
      <ProgressMeter
        label="Risk Pass Rate"
        :percent="riskPassPercent"
        :value-label="`${passCount} pass / ${checks?.length ?? 0} checks`"
        :status-label="riskPassPercent >= 50 ? 'PASS' : 'REVIEW'"
        helper="Computed from recent Risk Engine checks."
      />
    </div>

    <div class="grid gap-4 xl:grid-cols-2">
      <BarChart
        title="Risk Pass / Fail Summary"
        :data="riskSummary"
      />
      <BarChart
        title="Failed Rule Distribution"
        :data="failedRuleDistribution"
      />
    </div>

    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard
        title="Rules"
        subtitle="Paper trading risk controls from system settings."
        body-class="p-0"
      >
        <dl class="divide-y divide-slate-800/80">
          <div
            v-for="setting in settings ?? []"
            :key="setting.key"
            class="grid gap-1 px-4 py-3 md:grid-cols-2"
          >
            <dt class="text-sm text-slate-400">{{ setting.key }}</dt>
            <dd class="text-sm font-semibold text-slate-100">{{ setting.value }}</dd>
          </div>
          <div
            v-if="!(settings?.length)"
            class="p-4"
          >
            <EmptyState
              title="No risk settings"
              message="Risk settings were not returned by the current API response."
            />
          </div>
        </dl>
      </UiCard>

      <UiCard
        title="Risk Engine Checks"
        subtitle="Recent pass/fail decisions. This is distinct from AI Decision."
        body-class="p-0"
      >
        <DataTable
          :empty="!(checks?.length)"
          empty-label="No risk checks"
          :columns="['Stage', 'Risk Engine Decision', 'Failed Rules', 'Created']"
        >
          <tr
            v-for="check in checks ?? []"
            :key="check.id"
            class="border-t border-slate-800/80 hover:bg-slate-800/40"
          >
            <td class="px-4 py-3 font-medium">{{ check.stage }}</td>
            <td class="px-4 py-3"><StatusPill :label="check.result" /></td>
            <td class="px-4 py-3 text-slate-300">{{ Array.isArray(check.failedRules) && check.failedRules.length ? check.failedRules.join(', ') : '-' }}</td>
            <td class="px-4 py-3 text-slate-400">{{ date(check.createdAt) }}</td>
          </tr>
        </DataTable>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
type Setting = { key: string; value: unknown };
type RiskCheck = { id: string; stage: string; result: string; failedRules: string[]; createdAt: string };
type Portfolio = { dailyPnl: string };
type Dashboard = { reconciliation: { pendingOrderCount: number }; pendingProposals: unknown[] };

const { apiFetch } = useApi();
const { data: settings, error: settingsError } = await useAsyncData<Setting[]>('risk-settings-page', () => apiFetch('/risk/settings'));
const { data: checks, error: checksError } = await useAsyncData<RiskCheck[]>('risk-checks-page', () => apiFetch('/risk/checks?limit=30'));
const { data: portfolio, error: portfolioError } = await useAsyncData<Portfolio>('risk-portfolio-page', () => apiFetch('/portfolio'));
const { data: dashboard, error: dashboardError } = await useAsyncData<Dashboard>('risk-dashboard-page', () => apiFetch('/dashboard/paper'));

const maxDailyLoss = computed(() => settingNumber('max_daily_loss_usd'));
const dailyLossUsed = computed(() => Math.max(0, -number(portfolio.value?.dailyPnl)));
const dailyLossPercent = computed(() => maxDailyLoss.value > 0 ? (dailyLossUsed.value / maxDailyLoss.value) * 100 : 0);
const cooldownSeconds = computed(() => settingNumber('cooldown_between_trades_seconds'));
const cooldownConfiguredPercent = computed(() => cooldownSeconds.value > 0 ? 100 : 0);
const cooldownLabel = computed(() => cooldownSeconds.value > 0 ? `${cooldownSeconds.value}s configured` : 'No cooldown configured');
const pendingOrderPercent = computed(() => Math.min(100, ((dashboard.value?.reconciliation.pendingOrderCount ?? 0) / 10) * 100));
const passCount = computed(() => (checks.value ?? []).filter((check) => check.result === 'PASS').length);
const rejectCount = computed(() => (checks.value ?? []).filter((check) => check.result !== 'PASS').length);
const riskPassPercent = computed(() => checks.value?.length ? (passCount.value / checks.value.length) * 100 : 0);
const riskSummary = computed(() => [
  { label: 'PASS', value: passCount.value },
  { label: 'REJECT', value: rejectCount.value },
]);
const failedRuleDistribution = computed(() => {
  const counts = new Map<string, number>();
  for (const check of checks.value ?? []) {
    for (const rule of check.failedRules ?? []) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
});

function settingNumber(key: string): number {
  const value = settings.value?.find((setting) => setting.key === key)?.value;
  return number(typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
}

function number(value?: string): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
