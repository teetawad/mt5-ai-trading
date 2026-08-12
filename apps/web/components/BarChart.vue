<template>
  <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
    <div class="mb-3 flex items-center justify-between gap-3">
      <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ title }}</p>
      <span
        v-if="items.length"
        class="text-xs text-slate-500"
      >
        {{ items.length }} items
      </span>
    </div>
    <div
      v-if="items.length"
      class="space-y-3"
    >
      <div
        v-for="item in items"
        :key="item.label"
        class="space-y-1"
      >
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="truncate font-semibold text-slate-200">{{ item.label }}</span>
          <span :class="item.value < 0 ? 'text-rose-300' : 'text-slate-400'">{{ formatValue(item.value) }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            class="h-full rounded-full"
            :class="barClass(item.value)"
            :style="{ width: `${width(item.value)}%` }"
          />
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      title="No chart data"
      message="No real values are available for this chart yet."
    />
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string;
  data: Array<{ label: string; value: number }>;
  formatter?: (value: number) => string;
}>(), {
  formatter: undefined,
});

const items = computed(() => props.data.filter((item) => Number.isFinite(item.value)));
const maxAbs = computed(() => Math.max(1, ...items.value.map((item) => Math.abs(item.value))));

function width(value: number): number {
  return Math.max(3, Math.round((Math.abs(value) / maxAbs.value) * 100));
}

function barClass(value: number): string {
  if (value < 0) return 'bg-rose-400';
  return 'bg-sky-400';
}

function formatValue(value: number): string {
  return props.formatter ? props.formatter(value) : value.toLocaleString();
}
</script>
