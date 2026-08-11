<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Audit Log</h1>
      <p class="mt-1 text-sm text-slate-400">Owner actions and system events.</p>
    </div>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Time</th>
              <th class="px-4 py-3">Event</th>
              <th class="px-4 py-3">Action</th>
              <th class="px-4 py-3">Actor</th>
              <th class="px-4 py-3">Entity</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="log in data?.auditLogs ?? []"
              :key="log.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3">{{ date(log.createdAt) }}</td>
              <td class="px-4 py-3 font-medium">{{ log.eventType }}</td>
              <td class="px-4 py-3">{{ log.action }}</td>
              <td class="px-4 py-3">{{ log.actorEmail ?? '-' }}</td>
              <td class="px-4 py-3">{{ log.entityType ?? '-' }}</td>
            </tr>
            <tr v-if="!(data?.auditLogs?.length)">
              <td
                colspan="5"
                class="px-4 py-8 text-center text-slate-500"
              >
                No audit entries
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
type AuditLog = { id: string; eventType: string; action: string; actorEmail: string | null; entityType: string | null; createdAt: string };
const { apiFetch } = useApi();
const { data } = await useAsyncData<{ auditLogs: AuditLog[] }>('audit-page', () => apiFetch('/audit-logs?limit=50'));
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
