<template>
  <div class="overflow-x-auto">
    <table class="w-full table-fixed text-sm">
      <thead class="text-left text-xs uppercase text-slate-500">
        <tr>
          <th
            v-for="column in columns"
            :key="column"
            class="px-4 py-3"
          >
            {{ column }}
          </th>
        </tr>
      </thead>
      <tbody>
        <slot />
        <tr v-if="empty">
          <td
            :colspan="columns.length"
            class="border-t border-slate-800 px-4 py-8 text-center text-slate-500"
          >
            {{ emptyLabel }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  columns: string[];
  empty: boolean;
  emptyLabel: string;
}>();
</script>
