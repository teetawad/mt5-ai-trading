<template>
  <div class="rounded border border-slate-800 bg-slate-900 p-4">
    <p class="text-xs uppercase text-slate-500">{{ label }}</p>
    <p
      class="mt-2 min-h-8 break-words text-2xl font-semibold"
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
