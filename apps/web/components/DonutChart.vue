<template>
  <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
    <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{{ title }}</p>
    <div
      v-if="slices.length"
      class="grid gap-4 sm:grid-cols-[130px_1fr] sm:items-center"
    >
      <svg
        class="mx-auto h-32 w-32 -rotate-90"
        viewBox="0 0 42 42"
        role="img"
        :aria-label="title"
      >
        <circle
          cx="21"
          cy="21"
          fill="transparent"
          r="15.9155"
          stroke="#1e293b"
          stroke-width="6"
        />
        <circle
          v-for="slice in slices"
          :key="slice.label"
          cx="21"
          cy="21"
          fill="transparent"
          r="15.9155"
          :stroke="slice.color"
          stroke-width="6"
          :stroke-dasharray="`${slice.percent} ${100 - slice.percent}`"
          :stroke-dashoffset="slice.offset"
        />
      </svg>
      <div class="space-y-2">
        <div
          v-for="slice in slices"
          :key="slice.label"
          class="flex items-center justify-between gap-3 text-xs"
        >
          <span class="flex min-w-0 items-center gap-2 text-slate-300">
            <span
              class="h-2.5 w-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: slice.color }"
            />
            <span class="truncate">{{ slice.label }}</span>
          </span>
          <span class="font-semibold text-slate-100">{{ slice.display }}</span>
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      title="No allocation data"
      message="Open positions with market value are required for this chart."
    />
  </div>
</template>

<script setup lang="ts">
const palette = ['#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#2dd4bf'];

const props = defineProps<{
  title: string;
  data: Array<{ label: string; value: number }>;
  formatter?: (value: number) => string;
}>();

const slices = computed(() => {
  const rows = props.data.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = rows.reduce((sum, item) => sum + item.value, 0);
  let offset = 25;
  return rows.map((item, index) => {
    const percent = total > 0 ? (item.value / total) * 100 : 0;
    const slice = {
      label: item.label,
      percent,
      offset,
      color: palette[index % palette.length],
      display: props.formatter ? props.formatter(item.value) : item.value.toLocaleString(),
    };
    offset -= percent;
    return slice;
  });
});
</script>
