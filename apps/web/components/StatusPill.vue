<template>
  <span :class="classes">{{ label }}</span>
</template>

<script setup lang="ts">
const props = defineProps<{
  label: string;
}>();

const classes = computed(() => {
  const base = 'inline-flex min-w-20 justify-center rounded border px-2 py-1 text-xs font-semibold';
  if (props.label.includes('REJECT') || props.label.includes('ERROR')) {
    return `${base} border-rose-500/40 bg-rose-500/10 text-rose-200`;
  }
  if (props.label.includes('FILLED') || props.label.includes('PASS') || props.label === 'APPROVED') {
    return `${base} border-emerald-500/40 bg-emerald-500/10 text-emerald-200`;
  }
  if (props.label.includes('PENDING') || props.label.includes('SUBMIT')) {
    return `${base} border-sky-500/40 bg-sky-500/10 text-sky-200`;
  }
  if (props.label.includes('CANCEL') || props.label.includes('EXPIRED')) {
    return `${base} border-amber-500/40 bg-amber-500/10 text-amber-200`;
  }
  return `${base} border-slate-600 bg-slate-800 text-slate-200`;
});
</script>
