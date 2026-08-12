<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Settings</h1>
      <p class="mt-1 text-sm text-slate-400">Paper trading controls and risk parameters.</p>
    </div>
    <div
      v-if="message"
      class="rounded border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-100"
    >
      {{ message }}
    </div>
    <div
      v-if="actionError"
      class="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100"
    >
      {{ actionError }}
    </div>
    <section class="rounded border border-slate-800 bg-slate-900 p-4">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="font-semibold">Kill Switch</h2>
          <p class="mt-1 text-sm text-slate-400">Controls whether paper trading approvals and execution remain active.</p>
        </div>
        <button
          class="rounded border px-4 py-2 text-sm font-semibold"
          :class="killSwitch?.enabled ? 'border-rose-500/50 text-rose-200 hover:bg-rose-500/10' : 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10'"
          @click="toggleKillSwitch"
        >
          {{ killSwitch?.enabled ? 'Disable' : 'Enable' }}
        </button>
      </div>
    </section>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="border-b border-slate-800 px-4 py-3"><h2 class="font-semibold">System Settings</h2></div>
      <dl class="divide-y divide-slate-800">
        <div
          v-for="setting in settings ?? []"
          :key="setting.key"
          class="grid gap-1 px-4 py-3 md:grid-cols-3"
        >
          <dt class="text-sm text-slate-400">{{ setting.key }}</dt>
          <dd class="text-sm font-medium md:col-span-1">{{ setting.value }}</dd>
          <dd class="text-sm text-slate-500">{{ setting.description ?? '-' }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
type Setting = { key: string; value: unknown; description: string | null };
type KillSwitch = { enabled: boolean };
const { apiFetch } = useApi();
const message = ref('');
const actionError = ref('');
const { data: settings, refresh: refreshSettings } = await useAsyncData<Setting[]>('settings-page', () => apiFetch('/settings'));
const { data: killSwitch, refresh: refreshKillSwitch } = await useAsyncData<KillSwitch>('settings-kill-switch-page', () => apiFetch('/settings/kill-switch'));

async function toggleKillSwitch() {
  const enabled = !(killSwitch.value?.enabled ?? true);
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch('/settings/kill-switch', { method: 'PUT', body: { enabled } });
    message.value = `Kill switch ${enabled ? 'enabled' : 'disabled'}.`;
    await Promise.all([refreshSettings(), refreshKillSwitch()]);
  } catch (err) {
    actionError.value = err instanceof Error && err.message
      ? `Kill switch update failed: ${err.message}`
      : 'Kill switch update failed. Please try again.';
  }
}
</script>
