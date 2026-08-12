<template>
  <div class="relative min-h-44 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
    <div class="mb-3 flex items-start justify-between gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ title }}</p>
        <p
          v-if="valueLabel"
          class="mt-1 text-lg font-semibold text-slate-100"
        >
          {{ valueLabel }}
        </p>
      </div>
      <span
        v-if="series.length"
        class="rounded-full border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-400"
      >
        {{ series.length }} pts
      </span>
    </div>
    <svg
      v-if="path"
      class="h-28 w-full overflow-visible"
      preserveAspectRatio="none"
      viewBox="0 0 100 42"
      role="img"
      :aria-label="title"
    >
      <path
        :d="areaPath"
        :fill="fillColor"
        opacity="0.15"
      />
      <path
        :d="path"
        fill="none"
        :stroke="strokeColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2.4"
        vector-effect="non-scaling-stroke"
      />
      <circle
        v-if="lastPoint"
        :cx="lastPoint.x"
        :cy="lastPoint.y"
        r="1.9"
        :fill="strokeColor"
      />
    </svg>
    <EmptyState
      v-else
      title="No chart data"
      message="Historical values are not available from the current API response."
    />
  </div>
</template>

<script setup lang="ts">
type Point = { label: string; value: number };
type SvgPoint = { x: number; y: number };

const props = withDefaults(defineProps<{
  title: string;
  points: Point[];
  valueLabel?: string;
  tone?: 'sky' | 'emerald' | 'rose' | 'amber';
}>(), {
  valueLabel: '',
  tone: 'sky',
});

const colors = {
  sky: { stroke: '#38bdf8', fill: '#38bdf8' },
  emerald: { stroke: '#34d399', fill: '#34d399' },
  rose: { stroke: '#fb7185', fill: '#fb7185' },
  amber: { stroke: '#fbbf24', fill: '#fbbf24' },
};

const series = computed(() => props.points.filter((point) => Number.isFinite(point.value)));
const strokeColor = computed(() => colors[props.tone].stroke);
const fillColor = computed(() => colors[props.tone].fill);

const svgPoints = computed<SvgPoint[]>(() => {
  if (!series.value.length) return [];
  const values = series.value.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const count = series.value.length;
  return series.value.map((point, index) => ({
    x: count === 1 ? 50 : (index / (count - 1)) * 100,
    y: 38 - ((point.value - min) / span) * 32,
  }));
});

const path = computed(() => {
  if (!svgPoints.value.length) return '';
  return svgPoints.value.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
});

const areaPath = computed(() => {
  if (!path.value || !svgPoints.value.length) return '';
  const first = svgPoints.value[0];
  const last = svgPoints.value[svgPoints.value.length - 1];
  return `${path.value} L ${last.x.toFixed(2)} 42 L ${first.x.toFixed(2)} 42 Z`;
});

const lastPoint = computed(() => svgPoints.value.at(-1));
</script>
