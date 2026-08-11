<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
    <PaperTradingBanner />
    <nav class="border-b border-slate-800 bg-slate-950/95 px-4 py-3 shrink-0">
      <div class="mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <NuxtLink
          to="/"
          class="text-lg font-semibold tracking-tight text-white"
        >
          Trade Platform
        </NuxtLink>
        <div class="flex flex-wrap items-center gap-1 text-sm text-slate-300">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="rounded px-3 py-2 hover:bg-slate-800 hover:text-white"
            active-class="bg-slate-800 text-white"
          >
            {{ item.label }}
          </NuxtLink>
        </div>
      </div>
    </nav>
    <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/signals', label: 'Signals' },
  { to: '/orders', label: 'Orders' },
  { to: '/positions', label: 'Positions' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/risk', label: 'Risk' },
  { to: '/audit', label: 'Audit' },
  { to: '/settings', label: 'Settings' },
];
</script>
