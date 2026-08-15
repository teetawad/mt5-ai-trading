<template>
  <div class="relative min-h-56 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
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
        v-if="candles.length"
        class="rounded-full border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-400"
      >
        {{ candles.length }} candles
      </span>
    </div>
    <svg
      v-if="candles.length"
      class="h-48 w-full overflow-visible"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
      role="img"
      :aria-label="title"
    >
      <line
        v-for="marker in markers"
        :key="marker.key"
        x1="0"
        :y1="marker.y"
        x2="100"
        :y2="marker.y"
        :stroke="marker.color"
        stroke-width="0.5"
        stroke-dasharray="2,1.5"
        vector-effect="non-scaling-stroke"
      />
      <text
        v-for="marker in markers"
        :key="`${marker.key}-label`"
        x="99"
        :y="marker.y - 1.4"
        text-anchor="end"
        font-size="4"
        :fill="marker.color"
      >{{ marker.label }}</text>
      <g
        v-for="candle in candles"
        :key="candle.key"
      >
        <line
          :x1="candle.x"
          :y1="candle.highY"
          :x2="candle.x"
          :y2="candle.lowY"
          :stroke="candle.color"
          stroke-width="0.5"
          vector-effect="non-scaling-stroke"
        />
        <rect
          :x="candle.bodyX"
          :y="candle.bodyY"
          :width="candle.bodyWidth"
          :height="candle.bodyHeight"
          :fill="candle.color"
        />
      </g>
    </svg>
    <EmptyState
      v-else
      title="No candle data"
      message="Historical 1H bars are not available yet."
    />
  </div>
</template>

<script setup lang="ts">
type Bar = { timestamp: string; open: number; high: number; low: number; close: number };

const props = withDefaults(defineProps<{
  title: string;
  bars: Bar[];
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  valueLabel?: string;
}>(), {
  entry: null,
  stopLoss: null,
  takeProfit: null,
  valueLabel: '',
});

const UP_COLOR = '#34d399';
const DOWN_COLOR = '#fb7185';
const ENTRY_COLOR = '#38bdf8';
const TOP_MARGIN = 6;
const BOTTOM_MARGIN = 94;

const validBars = computed(() => props.bars.filter(
  (bar) => [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value)),
));

const priceRange = computed(() => {
  const values = validBars.value.flatMap((bar) => [bar.high, bar.low]);
  if (props.entry != null) values.push(props.entry);
  if (props.stopLoss != null) values.push(props.stopLoss);
  if (props.takeProfit != null) values.push(props.takeProfit);
  if (!values.length) return { min: 0, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
});

function yFor(price: number): number {
  const { min, max } = priceRange.value;
  const span = max - min || 1;
  return BOTTOM_MARGIN - ((price - min) / span) * (BOTTOM_MARGIN - TOP_MARGIN);
}

const candles = computed(() => {
  const count = validBars.value.length;
  if (!count) return [];
  const slot = 100 / count;
  const bodyWidth = Math.max(slot * 0.6, 0.6);
  return validBars.value.map((bar, index) => {
    const isUp = bar.close >= bar.open;
    const centerX = slot * index + slot / 2;
    const openY = yFor(bar.open);
    const closeY = yFor(bar.close);
    return {
      key: `${bar.timestamp}-${index}`,
      x: centerX,
      highY: yFor(bar.high),
      lowY: yFor(bar.low),
      bodyX: centerX - bodyWidth / 2,
      bodyY: Math.min(openY, closeY),
      bodyHeight: Math.max(Math.abs(closeY - openY), 0.6),
      bodyWidth,
      color: isUp ? UP_COLOR : DOWN_COLOR,
    };
  });
});

const markers = computed(() => {
  const list: { key: string; y: number; color: string; label: string }[] = [];
  if (props.entry != null) {
    list.push({ key: 'entry', y: yFor(props.entry), color: ENTRY_COLOR, label: `Entry ${props.entry.toFixed(2)}` });
  }
  if (props.takeProfit != null) {
    list.push({ key: 'tp', y: yFor(props.takeProfit), color: UP_COLOR, label: `TP ${props.takeProfit.toFixed(2)}` });
  }
  if (props.stopLoss != null) {
    list.push({ key: 'sl', y: yFor(props.stopLoss), color: DOWN_COLOR, label: `SL ${props.stopLoss.toFixed(2)}` });
  }
  return list;
});
</script>
