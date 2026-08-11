<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Orders</h1>
      <p class="mt-1 text-sm text-slate-400">Paper broker orders and fill progress.</p>
    </div>
    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Symbol</th>
              <th class="px-4 py-3">Side</th>
              <th class="px-4 py-3">Type</th>
              <th class="px-4 py-3">Quantity</th>
              <th class="px-4 py-3">Filled</th>
              <th class="px-4 py-3">Avg Fill</th>
              <th class="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="order in data?.orders ?? []"
              :key="order.id"
              class="border-t border-slate-800"
            >
              <td class="px-4 py-3 font-medium">{{ order.symbol }}</td>
              <td class="px-4 py-3">{{ order.side }}</td>
              <td class="px-4 py-3">{{ order.orderType }}</td>
              <td class="px-4 py-3">{{ order.quantity }}</td>
              <td class="px-4 py-3">{{ order.filledQuantity }}</td>
              <td class="px-4 py-3">{{ money(order.averageFillPrice) }}</td>
              <td class="px-4 py-3"><StatusPill :label="order.status" /></td>
            </tr>
            <tr v-if="!(data?.orders?.length)">
              <td
                colspan="7"
                class="px-4 py-8 text-center text-slate-500"
              >
                No orders
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
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
const { data } = await useAsyncData<{ orders: Order[] }>('orders-page', () => apiFetch('/orders?limit=50'));
function money(value?: string | null): string {
  return value ? `$${Number(value).toFixed(2)}` : '-';
}
</script>
