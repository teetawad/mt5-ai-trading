<template>
  <div class="space-y-6">
    <header>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Beginner settings</p>
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">
        Review demo automation and safety settings. Real and live MT5 accounts remain blocked server-side.
      </p>
    </header>

    <div v-if="message" class="notice-info">{{ message }}</div>
    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <UiCard title="AUTO-DEMO" subtitle="Default is OFF. It can only place DEMO trades after server-side Risk Engine approval.">
      <div class="grid gap-5 lg:grid-cols-[1fr_0.8fr]">
        <div>
          <div class="flex flex-wrap items-center gap-3">
            <StatusPill :label="autoDemo?.enabled ? 'AUTO-DEMO ON' : 'AUTO-DEMO OFF'" />
            <p class="text-sm text-slate-300">
              AUTO-DEMO lets AI place DEMO trades automatically after all Risk Engine checks pass.
            </p>
          </div>
          <p class="mt-4 text-sm leading-6 text-slate-300">
            It uses demo money only. It does not enable live trading, and the server still verifies MT5 demo mode, allowed login, allowed server, fresh data, Stop Loss, Take Profit, and duplicate protection before every order.
          </p>
          <div class="mt-4 flex flex-wrap gap-2">
            <button v-if="!autoDemo?.enabled" class="btn-success" :disabled="busy" @click="showAutoConfirm = true">Review Before Enabling</button>
            <button v-else class="btn-danger" :disabled="busy" @click="setAutoDemo(false)">Turn AUTO-DEMO Off</button>
            <NuxtLink to="/risk" class="btn-primary">Advanced Risk Settings</NuxtLink>
          </div>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <h2 class="text-sm font-semibold text-white">Protections always enforced</h2>
          <ul class="mt-3 space-y-2 text-sm text-slate-300">
            <li>- Maximum loss per trade</li>
            <li>- Maximum daily loss</li>
            <li>- Maximum open positions</li>
            <li>- Stop Loss mandatory</li>
            <li>- Take Profit mandatory</li>
            <li>- Real accounts blocked</li>
            <li>- Kill switch and stale data checks</li>
          </ul>
        </div>
      </div>
    </UiCard>

    <UiCard title="Terminology Help" subtitle="Beginner labels used throughout the app.">
      <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <InfoTile label="Stop Loss" value="Automatic loss limit" help="Automatic exit to limit loss." tone="loss" />
        <InfoTile label="Take Profit" value="Automatic target" help="Automatic exit when target profit is reached." tone="gain" />
        <InfoTile label="Spread" value="Buy/sell difference" help="Difference between buy and sell price." />
        <InfoTile label="Position Size" value="Trade size" help="How large this demo trade will be." />
        <InfoTile label="Risk/Reward" value="Loss vs target" help="Potential loss compared with target profit." />
        <InfoTile label="ATR" value="Advanced volatility" help="Hidden in beginner view unless you open advanced details." />
      </div>
    </UiCard>

    <div v-if="showAutoConfirm" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4">
      <section class="w-full max-w-xl rounded-lg border border-amber-400/40 bg-slate-900 p-5 shadow-2xl">
        <p class="text-xs font-bold uppercase tracking-widest text-amber-200">Explicit confirmation required</p>
        <h2 class="mt-2 text-xl font-semibold text-white">Enable AUTO-DEMO?</h2>
        <p class="mt-3 text-sm leading-6 text-slate-300">
          AUTO-DEMO can place demo trades without asking again, but only after the AI produces a BUY or SELL and the server-side Risk Engine passes.
        </p>
        <ul class="mt-4 space-y-2 rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
          <li>- Demo money only</li>
          <li>- Real accounts blocked</li>
          <li>- Stop Loss and Take Profit required</li>
          <li>- Maximum loss and daily limits enforced</li>
          <li>- Fresh market data required</li>
        </ul>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800" :disabled="busy" @click="showAutoConfirm = false">Cancel</button>
          <button class="btn-success" :disabled="busy" @click="setAutoDemo(true)">Enable AUTO-DEMO</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
const { apiFetch } = useApi();
const busy = ref(false);
const message = ref('');
const errorText = ref('');
const showAutoConfirm = ref(false);

const { data: autoDemo, refresh } = await useAsyncData<{ enabled: boolean }>('mt5-auto-demo-setting', () => apiFetch('/mt5/auto-demo'), { lazy: true });

async function setAutoDemo(enabled: boolean) {
  busy.value = true;
  message.value = '';
  errorText.value = '';
  try {
    autoDemo.value = await apiFetch<{ enabled: boolean }>('/mt5/auto-demo', { method: 'PUT', body: { enabled } });
    showAutoConfirm.value = false;
    message.value = enabled ? 'AUTO-DEMO is enabled for DEMO accounts only.' : 'AUTO-DEMO is off.';
    await refresh();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'AUTO-DEMO setting update failed';
  } finally {
    busy.value = false;
  }
}
</script>
