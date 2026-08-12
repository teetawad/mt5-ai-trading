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
    <UiCard
      title="Recent Audit Entries"
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
const { apiFetch } = useApi();
const { data, error } = await useAsyncData<{ auditLogs: AuditLog[] }>('audit-page', () => apiFetch('/audit-logs?limit=50'));
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
