<template>
  <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ label }}</p>
        <p class="mt-1 text-lg font-semibold text-slate-100">{{ valueLabel }}</p>
      </div>
      <StatusPill :label="statusLabel" />
    </div>
    <div class="mt-4 h-3 overflow-hidden rounded-full bg-slate-800">
      <div
        class="h-full rounded-full"
        :class="toneClass"
        :style="{ width: `${clampedPercent}%` }"
      />
    </div>
    <p
      v-if="helper"
      class="mt-2 text-xs text-slate-500"
    >
      {{ helper }}
    </p>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string;
  percent: number;
  valueLabel: string;
  statusLabel: string;
  helper?: string;
}>(), {
  helper: '',
});

const clampedPercent = computed(() => Math.max(0, Math.min(100, Number.isFinite(props.percent) ? props.percent : 0)));
const toneClass = computed(() => {
  if (clampedPercent.value >= 90) return 'bg-rose-400';
  if (clampedPercent.value >= 65) return 'bg-amber-300';
  return 'bg-emerald-400';
});
</script>
