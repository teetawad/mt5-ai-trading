<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Strategy Signals</h1>
      <p class="mt-1 text-sm text-slate-400">Signals emitted by strategies before proposal creation.</p>
    </div>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Symbol</th>
              <th class="px-4 py-3">Side</th>
              <th class="px-4 py-3">Reference</th>
              <th class="px-4 py-3">Confidence</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="signal in data?.signals ?? []"
              :key="signal.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3 font-medium">{{ signal.symbol }}</td>
              <td class="px-4 py-3">{{ signal.side }}</td>
              <td class="px-4 py-3">{{ money(signal.referencePrice) }}</td>
              <td class="px-4 py-3">{{ signal.confidence ?? '-' }}</td>
              <td class="px-4 py-3"><StatusPill :label="signal.status" /></td>
              <td class="px-4 py-3">{{ date(signal.createdAt) }}</td>
            </tr>
            <tr v-if="!(data?.signals?.length)">
              <td
                colspan="6"
                class="px-4 py-8 text-center text-slate-500"
              >
                No signals
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
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
const { apiFetch } = useApi();
const { data } = await useAsyncData<{ signals: Signal[] }>('signals-page', () => apiFetch('/signals?limit=50'));
function money(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
