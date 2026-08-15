<template>
  <div class="min-h-screen text-slate-100 flex flex-col">
    <PaperTradingBanner />
    <nav class="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 px-4 py-3 shadow-[0_12px_40px_rgba(2,6,23,0.35)] backdrop-blur shrink-0">
      <div class="mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <NuxtLink
          to="/"
          class="flex items-center gap-3 text-lg font-semibold tracking-tight text-white"
        >
          <span class="grid h-9 w-9 place-items-center rounded-lg border border-sky-400/30 bg-sky-400/10 text-sm text-sky-200">PT</span>
          <span>
            <span class="block leading-5">Paper Trade</span>
            <span class="block text-[11px] font-bold uppercase tracking-widest text-amber-200">Simulated execution</span>
          </span>
        </NuxtLink>
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div class="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1 text-sm text-slate-300">
            <NuxtLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="rounded-md px-3 py-2 transition hover:bg-slate-800 hover:text-white"
              active-class="bg-sky-400/10 text-sky-100"
            >
              {{ item.label }}
            </NuxtLink>
          </div>
          <button
            class="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
            :disabled="logoutBusy"
            type="button"
            @click="handleLogout"
          >
            {{ logoutBusy ? 'Signing out...' : 'Logout' }}
          </button>
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
  { to: '/hourly', label: 'Hourly' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/signals', label: 'Signals' },
  { to: '/crypto', label: 'Crypto' },
  { to: '/orders', label: 'Orders' },
  { to: '/positions', label: 'Positions' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/risk', label: 'Risk' },
  { to: '/audit', label: 'Audit' },
  { to: '/settings', label: 'Settings' },
];

const { logout } = useAuth();
const logoutBusy = ref(false);

async function handleLogout() {
  logoutBusy.value = true;
  try {
    await logout();
  } finally {
    logoutBusy.value = false;
  }
}
</script>
