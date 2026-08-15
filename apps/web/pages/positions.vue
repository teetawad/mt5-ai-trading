<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">MT5 DEMO POSITIONS</p>
      <h1 class="page-title">Positions</h1>
      <p class="page-subtitle">Open positions are reconciled from MT5 and persisted trade outcomes. Protective SL/TP should live at the broker where supported.</p>
    </div>
    <UiCard title="Current Implementation">
      <p class="text-sm text-slate-300">Position reconciliation is handled server-side through the MT5 adapter. This page is reserved for the realtime MT5 position stream and avoids showing stale Alpaca paper ledger data.</p>
    </UiCard>
  </div>
</template>
