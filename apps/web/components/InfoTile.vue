<template>
  <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-4" :title="help">
    <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ label }}</p>
    <p class="mt-2 text-lg font-semibold tracking-tight" :class="toneClass">{{ value }}</p>
    <p v-if="help" class="mt-2 text-xs leading-5 text-slate-500">{{ help }}</p>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string;
  value: string;
  help?: string;
  tone?: 'default' | 'loss' | 'gain';
}>(), {
  help: '',
  tone: 'default',
});

const toneClass = computed(() => {
  if (props.tone === 'loss') return 'text-rose-200';
  if (props.tone === 'gain') return 'text-emerald-200';
  return 'text-white';
});
</script>
