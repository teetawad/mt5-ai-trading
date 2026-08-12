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
  const base = 'inline-flex min-w-20 justify-center rounded border px-2 py-1 text-xs font-semibold';
  const label = displayLabel.value;
  if (label.includes('REJECT') || label.includes('ERROR')) {
    return `${base} border-rose-500/40 bg-rose-500/10 text-rose-200`;
  }
  if (label.includes('FILLED') || label.includes('PASS') || label === 'APPROVED') {
    return `${base} border-emerald-500/40 bg-emerald-500/10 text-emerald-200`;
  }
  if (label.includes('PENDING') || label.includes('SUBMIT')) {
    return `${base} border-sky-500/40 bg-sky-500/10 text-sky-200`;
  }
  if (label.includes('CANCEL') || label.includes('EXPIRED')) {
    return `${base} border-amber-500/40 bg-amber-500/10 text-amber-200`;
  }
  return `${base} border-slate-600 bg-slate-800 text-slate-200`;
});
</script>
