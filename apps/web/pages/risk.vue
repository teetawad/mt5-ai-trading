<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">SERVER-SIDE RISK</p>
      <h1 class="page-title">Risk</h1>
      <p class="page-subtitle">MT5 AUTO-DEMO risk limits. Frontend values never authorize execution.</p>
    </div>
    <div v-if="data" class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <MetricBox v-for="row in data" :key="row.key" :label="row.key" :value="String(row.value)" />
    </div>
  </div>
</template>

<script setup lang="ts">
const { apiFetch } = useApi();
const { data } = await useAsyncData<Array<{ key: string; value: unknown }>>('mt5-risk-settings', () => apiFetch('/mt5/risk-settings'));
</script>
