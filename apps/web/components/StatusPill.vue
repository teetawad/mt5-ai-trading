<template>
  <span :class="classes">{{ displayLabel }}</span>
</template>

<script setup lang="ts">
const props = defineProps<{
  label: string | null | undefined;
}>();

const displayLabel = computed(() => (
  typeof props.label === 'string' && props.label.trim() ? props.label : 'UNKNOWN'
));

const classes = computed(() => {
  const base = 'inline-flex min-w-20 justify-center rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide';
  const label = displayLabel.value;
  if (label.includes('REJECT') || label.includes('ERROR') || label.includes('FAIL') || label.includes('BLOCK')) {
    return `${base} border-rose-500/40 bg-rose-500/10 text-rose-200`;
  }
  if (label.includes('FILLED') || label.includes('PASS') || label === 'APPROVED' || label === 'LIVE' || label === 'FRESH' || label === 'CONNECTED' || label === 'CLEAR') {
    return `${base} border-emerald-500/40 bg-emerald-500/10 text-emerald-200`;
  }
  if (label.includes('PENDING') || label.includes('SUBMIT') || label.includes('AI') || label.includes('OWNER')) {
    return `${base} border-sky-500/40 bg-sky-500/10 text-sky-200`;
  }
  if (label.includes('CANCEL') || label.includes('EXPIRED') || label.includes('STALE') || label.includes('UNKNOWN') || label.includes('HOLD')) {
    return `${base} border-amber-500/40 bg-amber-500/10 text-amber-200`;
  }
  return `${base} border-slate-600 bg-slate-800 text-slate-200`;
});
</script>
