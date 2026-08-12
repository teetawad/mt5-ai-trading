<template>
  <div class="rounded-lg border border-slate-800/90 bg-slate-900/75 p-4 shadow-[0_18px_50px_rgba(2,6,23,0.18)]">
    <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ label }}</p>
    <p
      class="mt-2 min-h-8 break-words text-2xl font-semibold tracking-tight"
      :class="className"
    >
      {{ value }}
    </p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  className?: string;
}>();
</script>
