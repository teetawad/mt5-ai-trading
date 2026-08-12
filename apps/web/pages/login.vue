<template>
  <div class="min-h-screen text-slate-100">
    <PaperTradingBanner />
    <main class="mx-auto grid min-h-[calc(100vh-40px)] w-full max-w-5xl gap-8 px-4 py-10 lg:grid-cols-[1fr_420px] lg:items-center">
      <div class="hidden lg:block">
        <p class="text-xs font-semibold uppercase text-amber-200">PAPER TRADING ONLY</p>
        <h1 class="mt-2 text-4xl font-semibold tracking-tight text-white">Paper trading control room</h1>
        <p class="mt-3 max-w-xl text-sm leading-6 text-slate-400">Authenticate to review simulated orders, risk decisions, approvals, positions, and audit events. This interface does not enable live trading.</p>
        <div class="mt-6 grid max-w-xl gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-sky-400/30 bg-sky-400/10 p-3">
            <p class="text-xs font-bold uppercase tracking-wide text-sky-200">AI Decision</p>
          </div>
          <div class="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3">
            <p class="text-xs font-bold uppercase tracking-wide text-emerald-200">Risk Engine</p>
          </div>
          <div class="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3">
            <p class="text-xs font-bold uppercase tracking-wide text-amber-100">Owner Approval</p>
          </div>
        </div>
      </div>

      <form
        class="rounded-lg border border-slate-800 bg-slate-900/80 p-5 shadow-[0_24px_80px_rgba(2,6,23,0.35)]"
        @submit.prevent="submit"
      >
        <div class="mb-6 lg:hidden">
          <p class="text-xs font-semibold uppercase text-amber-200">PAPER TRADING ONLY</p>
          <h1 class="mt-2 text-2xl font-semibold text-white">Owner Login</h1>
          <p class="mt-1 text-sm text-slate-400">Authenticate to access the paper trading dashboard.</p>
        </div>
        <div class="mb-5 hidden lg:block">
          <h2 class="text-xl font-semibold text-white">Owner Login</h2>
          <p class="mt-1 text-sm text-slate-400">Use your owner account to continue.</p>
        </div>
        <div class="space-y-4">
          <label class="block">
            <span class="text-sm font-medium text-slate-200">Email</span>
            <input
              v-model.trim="email"
              autocomplete="username"
              class="field-input"
              name="email"
              required
              type="email"
            >
          </label>

          <label class="block">
            <span class="text-sm font-medium text-slate-200">Password</span>
            <input
              v-model="password"
              autocomplete="current-password"
              class="field-input"
              name="password"
              required
              type="password"
            >
          </label>

          <div
            v-if="errorMessage"
            class="notice-error"
          >
            {{ errorMessage }}
          </div>

          <button
            class="btn-primary w-full"
            :disabled="busy"
            type="submit"
          >
            {{ busy ? 'Signing in...' : 'Sign in' }}
          </button>
        </div>
      </form>
    </main>
  </div>
</template>

<script setup lang="ts">
definePageMeta({
  layout: false,
});

const route = useRoute();
const { login } = useAuth();
const email = ref('');
const password = ref('');
const busy = ref(false);
const errorMessage = ref('');

async function submit() {
  busy.value = true;
  errorMessage.value = '';

  try {
    await login({ email: email.value, password: password.value });
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await navigateTo(redirect.startsWith('/') ? redirect : '/');
  } catch {
    errorMessage.value = 'Invalid email or password.';
  } finally {
    busy.value = false;
  }
}
</script>
