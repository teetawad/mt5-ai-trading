<template>
  <section class="rounded-lg border border-slate-800/90 bg-slate-900/70 shadow-[0_18px_60px_rgba(2,6,23,0.28)]">
    <div
      v-if="title || subtitle || $slots.actions"
      class="flex flex-col gap-3 border-b border-slate-800/80 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div v-if="title || subtitle">
        <h2
          v-if="title"
          class="text-sm font-semibold tracking-wide text-slate-100"
        >
          {{ title }}
        </h2>
        <p
          v-if="subtitle"
          class="mt-1 text-xs leading-5 text-slate-400"
        >
          {{ subtitle }}
        </p>
      </div>
      <slot name="actions" />
    </div>
    <div :class="bodyClass">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title?: string;
  subtitle?: string;
  bodyClass?: string;
}>(), {
  title: '',
  subtitle: '',
  bodyClass: 'p-4',
});
</script>
