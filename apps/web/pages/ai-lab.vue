<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">CHAMPION / CHALLENGER</p>
      <h1 class="page-title">AI Lab</h1>
      <p class="page-subtitle">No online self-modifying AI. Challengers must pass chronological validation, out-of-sample tests, walk-forward evaluation, and promotion gates.</p>
    </div>
    <div class="grid gap-4 lg:grid-cols-3">
      <UiCard title="Champion"><p class="text-sm text-slate-300">BASELINE_MT5_H1_V1</p></UiCard>
      <UiCard title="Challengers"><p class="text-sm text-slate-300">Offline candidates only. No immediate deployment.</p></UiCard>
      <UiCard title="Promotion Gate"><p class="text-sm text-slate-300">Net P&L, expectancy, profit factor, drawdown, stability, MFE/MAE, and symbol coverage.</p></UiCard>
    </div>
  </div>
</template>
