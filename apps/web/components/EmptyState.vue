<template>
  <div class="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-slate-700/80 bg-slate-950/40 px-4 py-8 text-center">
    <p class="text-sm font-semibold text-slate-200">{{ title }}</p>
    <p
      v-if="message"
      class="mt-1 max-w-md text-xs leading-5 text-slate-500"
    >
      {{ message }}
    </p>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  message?: string;
}>(), {
  message: '',
});
</script>
