<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Audit Log</h1>
      <p class="page-subtitle">Owner actions and paper-trading system events for reviewability.</p>
    </div>
    <div
      v-if="error"
      class="notice-error"
    >
      Failed to load audit log. Please refresh the page.
    </div>
    <UiCard title="Filters">
      <div class="grid gap-3 md:grid-cols-5">
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Event Type</span>
          <select
            v-model="filters.eventType"
            class="field-input"
          >
            <option value="">All</option>
            <option
              v-for="type in EVENT_TYPES"
              :key="type"
              :value="type"
            >
              {{ type }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Entity ID</span>
          <input
            v-model="filters.entityId"
            type="text"
            placeholder="proposal / risk check UUID"
            class="field-input"
          >
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Actor ID</span>
          <input
            v-model="filters.actorId"
            type="text"
            placeholder="owner user UUID"
            class="field-input"
          >
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">From</span>
          <input
            v-model="filters.from"
            type="date"
            class="field-input"
          >
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">To</span>
          <input
            v-model="filters.to"
            type="date"
            class="field-input"
          >
        </label>
      </div>
      <div
        v-if="hasActiveFilters"
        class="mt-3"
      >
        <button
          class="text-xs font-semibold text-sky-300 hover:text-sky-200"
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>
    </UiCard>

    <UiCard
      :title="`Audit Entries (${data?.auditLogs?.length ?? 0})`"
      body-class="p-0"
    >
      <DataTable
        :empty="!(data?.auditLogs?.length)"
        empty-label="No audit entries"
        :columns="['Time', 'Event', 'Action', 'Actor', 'Entity']"
      >
        <tr
          v-for="log in data?.auditLogs ?? []"
          :key="log.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 text-slate-400">{{ date(log.createdAt) }}</td>
          <td class="px-4 py-3 font-semibold text-white">{{ log.eventType }}</td>
          <td class="px-4 py-3 text-slate-300">{{ log.action }}</td>
          <td class="px-4 py-3">{{ log.actorEmail ?? '-' }}</td>
          <td class="px-4 py-3"><StatusPill :label="log.entityType ?? 'SYSTEM'" /></td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type AuditLog = { id: string; eventType: string; action: string; actorEmail: string | null; entityType: string | null; createdAt: string };

// Mirrors the event_type values actually written via createAuditLog(...)
// across apps/api/src (auth, risk, kill switch, trade proposal / execution,
// bracket order lifecycle). Kept as a fixed list rather than derived from
// loaded rows so the dropdown doesn't shrink to only whatever the current
// filter happens to match.
const EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'KILL_SWITCH_UPDATED',
  'KILL_SWITCH_AUTO_DISABLED_DAILY_LOSS',
  'RISK_SETTING_UPDATED',
  'RISK_CHECK_COMPLETED',
  'TRADE_PROPOSAL_CREATED',
  'TRADE_PROPOSAL_CANCELLED',
  'TRADE_PROPOSAL_APPROVED',
  'TRADE_PROPOSAL_APPROVAL_RISK_REJECTED',
  'TRADE_PROPOSAL_REJECTED',
  'AI_DECISION_HOLD',
  'TRADE_EXECUTED',
  'TRADE_EXECUTION_ERROR',
  'BRACKET_ORDER_CREATED',
  'BRACKET_EXIT_RECONCILED',
];

const { apiFetch } = useApi();
const filters = reactive({ eventType: '', entityId: '', actorId: '', from: '', to: '' });
const hasActiveFilters = computed(() => Object.values(filters).some((value) => value !== ''));

function clearFilters() {
  filters.eventType = '';
  filters.entityId = '';
  filters.actorId = '';
  filters.from = '';
  filters.to = '';
}

function queryString(): string {
  const params = new URLSearchParams({ limit: '100' });
  if (filters.eventType) params.set('eventType', filters.eventType);
  if (filters.entityId) params.set('entityId', filters.entityId);
  if (filters.actorId) params.set('actorId', filters.actorId);
  if (filters.from) params.set('from', new Date(filters.from).toISOString());
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999Z`).toISOString());
  return params.toString();
}

const { data, error } = await useAsyncData<{ auditLogs: AuditLog[] }>(
  'audit-page',
  () => apiFetch(`/audit-logs?${queryString()}`),
  { watch: [filters] },
);

function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
