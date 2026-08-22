<template>
  <div class="min-h-screen text-slate-100 flex flex-col">
    <div class="safe-top border-b border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-emerald-100">
      MT5 AI DEMO TRADING LAB - DEMO ONLY - REAL/LIVE ACCOUNTS ARE BLOCKED SERVER-SIDE
    </div>
    <div v-if="!isOnline" class="border-b border-rose-400/40 bg-rose-500/15 px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-rose-100">
      API OFFLINE - no network connection. Data shown may be out of date.
    </div>

    <!-- Desktop nav (lg+). Unchanged from before, just gated to larger screens
         now that a dedicated mobile nav exists below. -->
    <nav class="sticky top-0 z-30 hidden border-b border-slate-800/80 bg-slate-950/90 px-4 py-3 shadow-[0_12px_40px_rgba(2,6,23,0.35)] backdrop-blur shrink-0 lg:block">
      <div class="mx-auto flex max-w-7xl flex-row items-center justify-between">
        <NuxtLink
          to="/"
          class="flex items-center gap-3 text-lg font-semibold tracking-tight text-white"
        >
          <span class="grid h-9 w-9 place-items-center rounded-lg border border-emerald-400/30 bg-emerald-400/10 text-sm text-emerald-200">MT5</span>
          <span>
            <span class="block leading-5">AI Demo Lab</span>
            <span class="block text-[11px] font-bold uppercase tracking-widest text-emerald-200">MT5 demo execution</span>
          </span>
        </NuxtLink>
        <div class="flex flex-row items-center gap-3">
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
          <div class="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/70 p-1 text-xs text-slate-400">
            <span class="px-2 py-2 font-bold uppercase tracking-wide text-slate-500">Advanced</span>
            <NuxtLink
              v-for="item in advancedItems"
              :key="item.to"
              :to="item.to"
              class="rounded-md px-2.5 py-2 transition hover:bg-slate-800 hover:text-white"
              active-class="bg-slate-800 text-slate-100"
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

    <!-- Mobile top bar (below lg): brand only, nav lives in the bottom tab bar. -->
    <div class="sticky top-0 z-30 flex items-center justify-center border-b border-slate-800/80 bg-slate-950/90 px-4 py-3 backdrop-blur shrink-0 lg:hidden">
      <NuxtLink to="/" class="flex items-center gap-2 text-base font-semibold tracking-tight text-white">
        <span class="grid h-8 w-8 place-items-center rounded-lg border border-emerald-400/30 bg-emerald-400/10 text-xs text-emerald-200">MT5</span>
        <span>AI Demo Lab</span>
      </NuxtLink>
    </div>

    <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6">
      <slot />
      <div class="mobile-nav-spacer lg:hidden" />
    </main>

    <!-- Mobile bottom tab bar (below lg). 5 items per spec: Home, AI Trade,
         Fast Learning, Trades, More (More opens the sheet with everything
         else, including Logout). -->
    <nav class="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-slate-800/80 bg-slate-950/95 px-1 pt-1 backdrop-blur lg:hidden">
      <div class="mx-auto flex max-w-xl items-stretch justify-between">
        <NuxtLink
          v-for="item in bottomNavItems"
          :key="item.to"
          :to="item.to"
          class="flex flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] font-semibold text-slate-400 transition hover:text-white"
          active-class="text-sky-300"
        >
          <span aria-hidden="true" class="text-lg leading-none">{{ item.icon }}</span>
          {{ item.label }}
        </NuxtLink>
        <button
          type="button"
          class="flex flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] font-semibold transition"
          :class="showMore ? 'text-sky-300' : 'text-slate-400 hover:text-white'"
          @click="showMore = true"
        >
          <span aria-hidden="true" class="text-lg leading-none">&#8942;</span>
          More
        </button>
      </div>
    </nav>

    <!-- "More" sheet: everything not in the bottom tab bar, plus Logout. -->
    <div v-if="showMore" class="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
      <button
        type="button"
        class="absolute inset-0 bg-slate-950/80"
        aria-label="Close menu"
        @click="showMore = false"
      />
      <div class="modal-safe-area absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-slate-800 bg-slate-900 p-4 shadow-[0_-12px_40px_rgba(2,6,23,0.5)]">
        <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-700" />
        <div class="grid grid-cols-2 gap-2">
          <NuxtLink
            v-for="item in moreItems"
            :key="item.to"
            :to="item.to"
            class="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            active-class="border-sky-400/40 bg-sky-400/10 text-sky-100"
            @click="showMore = false"
          >
            {{ item.label }}
          </NuxtLink>
        </div>
        <button
          class="mt-3 w-full rounded-lg border border-slate-700 px-3 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
          :disabled="logoutBusy"
          type="button"
          @click="handleLogout"
        >
          {{ logoutBusy ? 'Signing out...' : 'Logout' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const navItems = [
  { to: '/', label: 'Home' },
  { to: '/ai-trade', label: 'AI Trade' },
  { to: '/fast-learning', label: 'Fast Learning' },
  { to: '/positions', label: 'Open Trades' },
  { to: '/history', label: 'History' },
  { to: '/settings', label: 'Settings' },
];

const advancedItems = [
  { to: '/advanced/scanner', label: 'Scanner' },
  { to: '/advanced/risk', label: 'Risk Engine' },
  { to: '/advanced/diagnostics', label: 'Diagnostics' },
  { to: '/ai-lab', label: 'AI Lab' },
];

// Mobile bottom tab bar: 5 items max per spec section 6. Everything else
// (History, Settings, and the Advanced pages) lives in the "More" sheet.
const bottomNavItems = [
  { to: '/', label: 'Home', icon: '\u{1F3E0}' },
  { to: '/ai-trade', label: 'AI Trade', icon: '\u{1F4C8}' },
  { to: '/fast-learning', label: 'Learning', icon: '\u{1F9E0}' },
  { to: '/positions', label: 'Trades', icon: '\u{1F4CA}' },
];

const moreItems = [
  { to: '/history', label: 'History' },
  { to: '/settings', label: 'Settings' },
  { to: '/advanced/scanner', label: 'Scanner' },
  { to: '/advanced/risk', label: 'Risk Engine' },
  { to: '/advanced/diagnostics', label: 'Diagnostics' },
  { to: '/ai-lab', label: 'AI Lab' },
];

const showMore = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => {
  showMore.value = false;
});

const { isOnline } = useNetworkStatus();
useAppLifecycle();

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
