<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Risk</h1>
      <p class="mt-1 text-sm text-slate-400">Current rule settings and recent risk checks.</p>
    </div>
    <div class="grid gap-6 xl:grid-cols-2">
      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3"><h2 class="font-semibold">Rules</h2></div>
        <dl class="divide-y divide-slate-800">
          <div
            v-for="setting in settings ?? []"
            :key="setting.key"
            class="grid gap-1 px-4 py-3 md:grid-cols-2"
          >
            <dt class="text-sm text-slate-400">{{ setting.key }}</dt>
            <dd class="text-sm font-medium">{{ setting.value }}</dd>
          </div>
        </dl>
      </section>
      <section class="rounded border border-slate-800 bg-slate-900">
        <div class="border-b border-slate-800 px-4 py-3"><h2 class="font-semibold">Checks</h2></div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-slate-500">
              <tr>
                <th class="px-4 py-3">Stage</th>
                <th class="px-4 py-3">Result</th>
                <th class="px-4 py-3">Failed Rules</th>
                <th class="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="check in checks ?? []"
                :key="check.id"
                class="border-t border-slate-800"
              >
                <td class="px-4 py-3">{{ check.stage }}</td>
                <td class="px-4 py-3"><StatusPill :label="check.result" /></td>
                <td class="px-4 py-3">{{ check.failedRules.join(', ') || '-' }}</td>
                <td class="px-4 py-3">{{ date(check.createdAt) }}</td>
              </tr>
              <tr v-if="!(checks?.length)">
                <td
                  colspan="4"
                  class="px-4 py-8 text-center text-slate-500"
                >
                  No risk checks
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type Setting = { key: string; value: unknown };
type RiskCheck = { id: string; stage: string; result: string; failedRules: string[]; createdAt: string };
const { apiFetch } = useApi();
const { data: settings } = await useAsyncData<Setting[]>('risk-settings-page', () => apiFetch('/risk/settings'));
const { data: checks } = await useAsyncData<RiskCheck[]>('risk-checks-page', () => apiFetch('/risk/checks?limit=30'));
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
