<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Strategy Signals</h1>
      <p class="mt-1 text-sm text-slate-400">Signals emitted by strategies before proposal creation.</p>
    </div>

    <section class="rounded border border-sky-500/40 bg-slate-900 p-4">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-sky-300">MANUAL TEST / PAPER ONLY</div>
          <h2 class="mt-1 text-lg font-semibold">Create Paper Test Signal</h2>
        </div>
        <StatusPill label="PAPER ONLY" />
      </div>

      <form
        class="mt-4 grid gap-3 md:grid-cols-[1.2fr_0.8fr_0.8fr_auto]"
        @submit.prevent="createManualSignal"
      >
        <label class="block">
          <span class="text-xs uppercase text-slate-500">US stock symbol</span>
          <select
            v-model="form.symbol"
            class="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            required
          >
            <option
              v-for="symbol in options?.symbols ?? []"
              :key="symbol"
              :value="symbol"
            >
              {{ symbol }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Side</span>
          <select
            v-model="form.side"
            class="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase text-slate-500">Quantity</span>
          <input
            v-model="form.quantity"
            class="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            inputmode="decimal"
            pattern="^\d+(\.\d+)?$"
            required
          >
        </label>
        <button
          class="mt-5 rounded border border-sky-500/50 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/10 disabled:opacity-40"
          :disabled="busy || !(options?.symbols?.length)"
          type="submit"
        >
          Create
        </button>
      </form>

      <div
        v-if="message"
        class="mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100"
      >
        {{ message }}
        <NuxtLink
          v-if="createdProposalId"
          class="ml-2 font-semibold underline"
          :to="`/proposals?proposalId=${createdProposalId}`"
        >
          Open generated proposal
        </NuxtLink>
      </div>
      <div
        v-if="submitError"
        class="mt-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100"
      >
        {{ submitError }}
      </div>
    </section>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Symbol</th>
              <th class="px-4 py-3">Side</th>
              <th class="px-4 py-3">Reference</th>
              <th class="px-4 py-3">Confidence</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="signal in data?.signals ?? []"
              :key="signal.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3 font-medium">{{ signal.symbol }}</td>
              <td class="px-4 py-3">{{ signal.side }}</td>
              <td class="px-4 py-3">{{ money(signal.referencePrice) }}</td>
              <td class="px-4 py-3">{{ signal.confidence ?? '-' }}</td>
              <td class="px-4 py-3"><StatusPill :label="signal.status" /></td>
              <td class="px-4 py-3">{{ date(signal.createdAt) }}</td>
            </tr>
            <tr v-if="!(data?.signals?.length)">
              <td
                colspan="6"
                class="px-4 py-8 text-center text-slate-500"
              >
                No signals
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
type Signal = {
  id: string;
  symbol: string;
  side: string;
  referencePrice: string;
  confidence: string | null;
  status: string;
  createdAt: string;
};
type ManualOptions = {
  symbols: string[];
};
type ManualSignalResult = {
  signal: Signal;
  proposal: {
    id: string;
    status: string;
    referencePrice: string;
  };
};
const { apiFetch } = useApi();
const busy = ref(false);
const message = ref('');
const submitError = ref('');
const createdProposalId = ref('');
const form = reactive({
  symbol: '',
  side: 'BUY' as 'BUY' | 'SELL',
  quantity: '1',
});
const { data: options } = await useAsyncData<ManualOptions>('manual-test-signal-options', () => apiFetch('/signals/manual-test/options'));
const { data, refresh } = await useAsyncData<{ signals: Signal[] }>('signals-page', () => apiFetch('/signals?limit=50'));

watchEffect(() => {
  if (!form.symbol && options.value?.symbols?.length) {
    form.symbol = options.value.symbols[0];
  }
});

async function createManualSignal() {
  busy.value = true;
  message.value = '';
  submitError.value = '';
  createdProposalId.value = '';
  try {
    const result = await apiFetch<ManualSignalResult>('/signals/manual-test', {
      method: 'POST',
      body: {
        symbol: form.symbol,
        side: form.side,
        quantity: form.quantity,
      },
    });
    createdProposalId.value = result.proposal.id;
    message.value = `Manual PAPER test signal created at ${money(result.proposal.referencePrice)}. Proposal status: ${result.proposal.status}.`;
    await refresh();
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Failed to create manual PAPER test signal.';
  } finally {
    busy.value = false;
  }
}

function money(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}
function date(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
