<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4">
    <section
      class="w-full max-w-xl rounded-lg border p-5 shadow-2xl"
      :class="borderClass"
    >
      <!-- CONFIRM: shown before anything is sent to MT5. -->
      <template v-if="state === 'idle'">
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Owner confirmation required</p>
        <h2 class="mt-2 text-xl font-semibold text-white">CONFIRM DEMO TRADE</h2>
        <div class="mt-3 flex items-center gap-2">
          <span class="text-2xl font-bold text-white">{{ plan.symbol }}</span>
          <StatusPill :label="String(plan.decision.action)" />
        </div>
        <p class="mt-3 rounded-lg border border-amber-400/50 bg-amber-400/10 p-3 text-sm font-bold leading-6 text-amber-100">
          THIS WILL CREATE AN ACTUAL POSITION INSIDE THE CONNECTED MT5 DEMO ACCOUNT.
        </p>
        <div class="mt-4 grid gap-2 text-sm text-slate-300">
          <div class="flex justify-between gap-4"><span>Current price</span><strong>{{ priceText(currentPrice) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Entry</span><strong>{{ priceText(entryPrice) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Volume</span><strong>{{ lotText }}</strong></div>
          <div class="flex justify-between gap-4"><span>Stop Loss</span><strong class="text-rose-200">{{ priceText(stopLoss) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Take Profit</span><strong class="text-emerald-200">{{ priceText(takeProfit) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Maximum planned loss</span><strong class="text-rose-200">{{ money(maxLoss) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Target profit</span><strong class="text-emerald-200">{{ money(targetProfit) }}</strong></div>
        </div>
        <div class="mt-4 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">MT5 Account</p>
          <p class="mt-1 font-semibold text-white">{{ accountLogin }}</p>
          <p class="text-slate-400">{{ accountServer }}</p>
        </div>
        <p class="mt-4 text-center text-xs font-bold uppercase tracking-widest text-emerald-300">Demo money only</p>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            @click="$emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-success"
            @click="$emit('confirm')"
          >
            Confirm Trade in MT5 Demo
          </button>
        </div>
      </template>

      <!-- SENDING: the whole risk-recheck -> order_check -> order_send ->
           positions_get() chain is one backend request/response - there is
           no intermediate event to report, so this stays a single honest
           "in progress" state, never fake step-by-step ticks. -->
      <template v-else-if="state === 'sending'">
        <p class="text-xs font-bold uppercase tracking-widest text-sky-200">Opening in MT5 Demo</p>
        <h2 class="mt-2 text-xl font-semibold text-white">{{ plan.symbol }} {{ plan.decision.action }} — sending your DEMO order...</h2>
        <div class="mt-4 flex items-center gap-3 rounded-lg border border-sky-400/30 bg-sky-400/10 p-3">
          <span class="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
          <span class="text-sm font-semibold text-sky-100">Do not close this window.</span>
        </div>
        <p class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">What is happening now</p>
        <ol class="mt-2 space-y-2 text-sm text-slate-400">
          <li
            v-for="(item, index) in progressSteps"
            :key="item"
            class="flex items-start gap-2"
          >
            <span class="text-slate-600">{{ index + 1 }}.</span>
            <span>{{ item }}</span>
          </li>
        </ol>
      </template>

      <!-- SUCCESS: only ever rendered when the backend has already
           confirmed a real MT5 position via positions_get(). -->
      <template v-else-if="state === 'success'">
        <div class="rounded-lg border border-emerald-400/50 bg-emerald-400/10 p-3">
          <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">&#10003; MT5 CONFIRMED</p>
          <h2 class="mt-1 text-2xl font-bold text-emerald-100">DEMO TRADE OPENED IN MT5</h2>
        </div>
        <p class="mt-3 text-sm font-bold uppercase tracking-wide text-emerald-300">MT5 POSITION CONFIRMED</p>
        <div class="mt-2 flex items-center gap-2">
          <span class="text-xl font-bold text-white">{{ outcome?.symbol }}</span>
          <StatusPill :label="String(outcome?.side ?? '')" />
        </div>
        <div class="mt-4 grid gap-2 text-sm text-slate-300">
          <div class="flex justify-between gap-4"><span>MT5 Ticket</span><strong class="text-white">{{ outcome?.ticket ?? outcome?.orderTicket ?? '-' }}</strong></div>
          <div class="flex justify-between gap-4"><span>Volume</span><strong>{{ numberText(outcome?.volume) }} lot</strong></div>
          <div class="flex justify-between gap-4"><span>Actual Entry</span><strong>{{ priceText(outcome?.actualEntry) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Stop Loss</span><strong class="text-rose-200">{{ priceText(outcome?.stopLoss) }}</strong></div>
          <div class="flex justify-between gap-4"><span>Take Profit</span><strong class="text-emerald-200">{{ priceText(outcome?.takeProfit) }}</strong></div>
        </div>
        <p class="mt-4 text-sm leading-6 text-slate-300">The trade is now active in your MetaTrader 5 DEMO account.</p>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            @click="$emit('close')"
          >
            Close
          </button>
          <button
            type="button"
            class="btn-success"
            @click="$emit('view-open-trade')"
          >
            View Open Trade
          </button>
        </div>
      </template>

      <!-- ALREADY EXECUTED: a duplicate/second click landed after the plan
           had already opened a real MT5 position — this is not a failure
           the owner needs to act on, it's informational, so it gets the
           same green "MT5 CONFIRMED" framing as a fresh success, not the
           red failure card. -->
      <template v-else-if="state === 'failed' && outcome?.code === 'ALREADY_EXECUTED'">
        <div class="rounded-lg border border-emerald-400/50 bg-emerald-400/10 p-3">
          <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">&#10003; MT5 CONFIRMED</p>
          <h2 class="mt-1 text-2xl font-bold text-emerald-100">ALREADY OPENED IN MT5</h2>
        </div>
        <p class="mt-3 text-sm font-bold uppercase tracking-wide text-emerald-300">MT5 POSITION CONFIRMED</p>
        <p class="mt-2 text-sm leading-6 text-slate-300">{{ outcome?.message ?? 'This entry plan already executed in MT5.' }}</p>
        <div
          v-if="outcome?.ticket"
          class="mt-4 grid gap-2 text-sm text-slate-300"
        >
          <div class="flex justify-between gap-4"><span>MT5 Ticket</span><strong class="text-white">{{ outcome.ticket }}</strong></div>
          <div
            v-if="outcome.volume"
            class="flex justify-between gap-4"
          ><span>Volume</span><strong>{{ numberText(outcome.volume) }} lot</strong></div>
          <div
            v-if="outcome.actualEntry"
            class="flex justify-between gap-4"
          ><span>Actual Entry</span><strong>{{ priceText(outcome.actualEntry) }}</strong></div>
        </div>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            @click="$emit('close')"
          >
            Close
          </button>
          <button
            type="button"
            class="btn-success"
            @click="$emit('view-open-trade')"
          >
            View Open Trade
          </button>
        </div>
      </template>

      <!-- FAILED: exposes the real backend code/message, never a generic
           "Risk Engine rejected" string. -->
      <template v-else-if="state === 'failed'">
        <div class="rounded-lg border border-rose-400/50 bg-rose-400/10 p-3">
          <h2 class="text-2xl font-bold text-rose-100">DEMO TRADE NOT OPENED</h2>
          <p class="mt-1 text-sm font-bold uppercase tracking-wide text-rose-200">NO MT5 POSITION WAS OPENED</p>
        </div>
        <p class="mt-3 text-sm text-slate-300">MT5 did not create a position.</p>
        <div class="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason</p>
          <p class="mt-1 text-lg font-bold text-rose-200">{{ outcome?.code ?? 'UNKNOWN' }}</p>
          <p
            v-if="outcome?.message"
            class="mt-1 text-sm leading-6 text-slate-300"
          >
            {{ outcome.message }}
          </p>
        </div>
        <p class="mt-3 text-sm font-semibold text-slate-300">No DEMO trade was opened.</p>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            @click="$emit('close')"
          >
            Close
          </button>
          <button
            type="button"
            class="btn-primary"
            @click="$emit('analyze-again')"
          >
            Analyze Again
          </button>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { TradeExecutionOutcome, TradeExecutionState } from '../composables/useTradeExecution';

const props = defineProps<{
  plan: {
    symbol: string;
    decision: Record<string, any>;
    entryPlan: Record<string, any>;
    protection: Record<string, any>;
    positionSizing: Record<string, any>;
    quote: Record<string, any>;
    status?: Record<string, any>;
  };
  state: TradeExecutionState;
  outcome: TradeExecutionOutcome | null;
}>();

defineEmits<{
  cancel: [];
  confirm: [];
  close: [];
  'view-open-trade': [];
  'analyze-again': [];
}>();

const progressSteps = [
  'Checking current market...',
  'Checking Risk Engine...',
  'Checking MT5 Demo account...',
  'Validating order with MT5...',
  'Sending DEMO order...',
  'Waiting for MT5 confirmation...',
];

const currentPrice = computed(() => props.plan.quote?.currentPrice ?? props.plan.entryPlan?.current_price);
const entryPrice = computed(() => props.plan.entryPlan?.reference_entry);
const stopLoss = computed(() => props.plan.protection?.stopLoss);
const takeProfit = computed(() => props.plan.protection?.takeProfit);
const maxLoss = computed(() => props.plan.positionSizing?.maximumPlannedLoss);
const targetProfit = computed(() => props.plan.positionSizing?.targetProfit);
const lotText = computed(() => {
  const value = Number(props.plan.positionSizing?.recommendedLotSize);
  return Number.isFinite(value) && value > 0 ? `${value} lot` : '-';
});
const accountLogin = computed(() => props.plan.status?.account?.login ?? '-');
const accountServer = computed(() => props.plan.status?.account?.server ?? '-');

const borderClass = computed(() => {
  if (props.state === 'success') return 'border-emerald-400/50 bg-slate-900';
  if (props.state === 'failed') return 'border-rose-400/50 bg-slate-900';
  return 'border-sky-400/40 bg-slate-900';
});

function priceText(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || value === null || value === undefined || value === '') return '-';
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function numberText(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '-';
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$-';
  return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
</script>
