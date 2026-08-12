<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Orders</h1>
      <p class="page-subtitle">Paper broker orders and fill progress with clearer status and execution readability.</p>
    </div>
    <div
      v-if="error"
      class="notice-error"
    >
      Failed to load orders. Please refresh the page.
    </div>
    <div class="grid gap-3 md:grid-cols-4">
      <MetricBox
        label="Total Orders"
        :value="String(data?.orders.length ?? 0)"
      />
      <MetricBox
        label="Submitted"
        :value="String(statusCount('SUBMITTED'))"
        class-name="text-sky-300"
      />
      <MetricBox
        label="Filled"
        :value="String(statusCount('FILLED'))"
        class-name="text-emerald-300"
      />
      <MetricBox
        label="Rejected/Error"
        :value="String(errorCount)"
        class-name="text-rose-300"
      />
    </div>
    <UiCard
      title="Paper Orders"
      body-class="p-0"
    >
      <DataTable
        :empty="!(data?.orders?.length)"
        empty-label="No orders"
        :columns="['Symbol', 'Side', 'Type', 'Quantity', 'Filled', 'Avg Fill', 'Status']"
      >
        <tr
          v-for="order in data?.orders ?? []"
          :key="order.id"
          class="border-t border-slate-800/80 hover:bg-slate-800/40"
        >
          <td class="px-4 py-3 font-semibold text-white">{{ order.symbol }}</td>
          <td class="px-4 py-3">{{ order.side }}</td>
          <td class="px-4 py-3">{{ order.orderType }}</td>
          <td class="px-4 py-3 tabular-nums">{{ order.quantity }}</td>
          <td class="px-4 py-3 tabular-nums">{{ order.filledQuantity }}</td>
          <td class="px-4 py-3 tabular-nums">{{ money(order.averageFillPrice) }}</td>
          <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
        </tr>
      </DataTable>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type Order = {
  id: string;
  symbol: string;
  side: string;
  orderType: string;
  quantity: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  status: string;
};
const { apiFetch } = useApi();
const { data, error } = await useAsyncData<{ orders: Order[] }>('orders-page', () => apiFetch('/orders?limit=50'));
const errorCount = computed(() => (data.value?.orders ?? []).filter((order) => ['REJECTED', 'ERROR', 'CANCELLED'].includes(order.status)).length);
function statusCount(status: string): number {
  return (data.value?.orders ?? []).filter((order) => order.status === status).length;
}
function money(value?: string | null): string {
  return value ? `$${Number(value).toFixed(2)}` : '-';
}
</script>
