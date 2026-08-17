<template>
  <div class="space-y-6">
    <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Thailand time: {{ data?.timezone ?? 'Asia/Bangkok' }}</p>
        <h1 class="page-title">Market Hours</h1>
        <p class="page-subtitle">
          See which enabled MT5 demo markets are open, when sessions open/close, and which markets are worth watching now.
        </p>
      </div>
      <button class="btn-primary" :disabled="busy" @click="refreshPage">{{ busy ? 'Refreshing...' : 'Refresh' }}</button>
    </header>

    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <UiCard title="Recommended Markets to Trade Now" subtitle="Ranked by open market, fresh data, AI readiness, and Risk Engine readiness.">
      <div v-if="recommended.length" class="grid gap-3 lg:grid-cols-2">
        <div v-for="market in recommended" :key="market.symbol" class="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="font-semibold text-white">{{ market.symbol }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ labelAsset(market.assetClass) }}</p>
            </div>
            <StatusPill :label="String(market.status)" />
          </div>
          <p class="mt-3 text-sm leading-6 text-slate-300">{{ market.recommendation }}</p>
          <p class="mt-2 text-xs text-slate-500">Recommendation score {{ market.recommendationScore }}/100</p>
        </div>
      </div>
      <EmptyState v-else title="No recommendations" message="Enable watchlist symbols and run AI analysis to populate market recommendations." />
    </UiCard>

    <UiCard title="Session Status" subtitle="Displayed in local Thailand time when MT5 session metadata is available." body-class="p-0">
      <DataTable
        :columns="['Market','Asset Class','Status','Data','Session Open','Session Close','Next Open','Next Close','Countdown','Notes']"
        :empty="markets.length === 0"
        empty-label="No enabled symbols found. Choose symbols on Home or AI Analysis first."
      >
        <tr v-for="market in markets" :key="market.symbol" class="border-t border-slate-800/80 hover:bg-slate-800/40">
          <td class="whitespace-nowrap px-4 py-3 font-semibold text-white">{{ market.symbol }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ labelAsset(market.assetClass) }}</td>
          <td class="whitespace-nowrap px-4 py-3"><StatusPill :label="String(market.status)" /></td>
          <td class="whitespace-nowrap px-4 py-3"><StatusPill :label="String(market.dataStatus)" /></td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ market.sessionOpenThailand ?? '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ market.sessionCloseThailand ?? '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ market.nextOpenThailand ?? '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-400">{{ market.nextCloseThailand ?? '-' }}</td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-300">{{ market.countdown ?? '-' }}</td>
          <td class="min-w-72 px-4 py-3 text-slate-400">{{ market.uncertainty ?? market.recommendation }}</td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type MarketRow = {
  symbol: string;
  assetClass: string;
  status: string;
  dataStatus: string;
  sessionOpenThailand?: string | null;
  sessionCloseThailand?: string | null;
  nextOpenThailand?: string | null;
  nextCloseThailand?: string | null;
  countdown?: string | null;
  recommendationScore: number;
  recommendation: string;
  uncertainty?: string | null;
};

const { apiFetch } = useApi();
const busy = ref(false);
const errorText = ref('');
const { data, refresh } = await useAsyncData<{ timezone: string; markets: MarketRow[]; recommended: MarketRow[] }>('mt5-market-hours', () => apiFetch('/mt5/market-hours'));
useAutoRefresh(refresh, 30000);

const markets = computed(() => data.value?.markets ?? []);
const recommended = computed(() => data.value?.recommended ?? []);

async function refreshPage() {
  busy.value = true;
  errorText.value = '';
  try {
    await refresh();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'Market hours refresh failed';
  } finally {
    busy.value = false;
  }
}

function labelAsset(value: string) {
  return value.replace('_CFD', '').replace('_', ' ');
}
</script>
