<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <PaperTradingBanner />
    <main class="mx-auto flex min-h-[calc(100vh-40px)] w-full max-w-md flex-col justify-center px-4 py-10">
      <div class="mb-6">
        <p class="text-xs font-semibold uppercase text-amber-200">PAPER TRADING ONLY</p>
        <h1 class="mt-2 text-2xl font-semibold text-white">Owner Login</h1>
        <p class="mt-1 text-sm text-slate-400">Authenticate to access the paper trading dashboard.</p>
      </div>

      <form
        class="rounded border border-slate-800 bg-slate-900 p-4"
        @submit.prevent="submit"
      >
        <div class="space-y-4">
          <label class="block">
            <span class="text-sm font-medium text-slate-200">Email</span>
            <input
              v-model.trim="email"
              autocomplete="username"
              class="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
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
              class="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
              name="password"
              required
              type="password"
            >
          </label>

          <div
            v-if="errorMessage"
            class="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100"
          >
            {{ errorMessage }}
          </div>

          <button
            class="w-full rounded border border-sky-500/60 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
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
