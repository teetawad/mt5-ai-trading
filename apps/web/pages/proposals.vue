<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Trade Proposals</h1>
      <p class="mt-1 text-sm text-slate-400">Review immutable proposals and record owner decisions.</p>
    </div>

    <div
      v-if="message"
      class="rounded border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-100"
    >
      {{ message }}
    </div>
    <div
      v-if="error"
      class="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100"
    >
      {{ error.message }}
    </div>

    <section class="rounded border border-slate-800 bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-4 py-3">Symbol</th>
              <th class="px-4 py-3">Side</th>
              <th class="px-4 py-3">Quantity</th>
              <th class="px-4 py-3">Reference</th>
              <th class="px-4 py-3">Expires</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="proposal in proposals?.proposals ?? []"
              :key="proposal.id"
              class="border-t border-slate-800 hover:bg-slate-800/50"
              @click="selected = proposal"
            >
              <td class="px-4 py-3 font-medium">{{ proposal.symbol }}</td>
              <td class="px-4 py-3">{{ proposal.side }}</td>
              <td class="px-4 py-3">{{ proposal.quantity }}</td>
              <td class="px-4 py-3">{{ currency(proposal.referencePrice) }}</td>
              <td class="px-4 py-3">{{ shortDate(proposal.expiresAt) }}</td>
              <td class="px-4 py-3"><StatusPill :label="proposal.status" /></td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-2">
                  <button
                    class="rounded border border-emerald-500/50 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                    :disabled="proposal.status !== 'PENDING_APPROVAL' || busy"
                    @click="approve(proposal.id)"
                  >
                    Approve
                  </button>
                  <button
                    class="rounded border border-rose-500/50 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-40"
                    :disabled="proposal.status !== 'PENDING_APPROVAL' || busy"
                    @click="reject(proposal.id)"
                  >
                    Reject
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!(proposals?.proposals?.length)">
              <td
                colspan="7"
                class="px-4 py-8 text-center text-slate-500"
              >
                No proposals
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section
      v-if="selected"
      class="rounded border border-slate-800 bg-slate-900 p-4"
    >
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 class="font-semibold">{{ selected.symbol }} Proposal Detail</h2>
          <p class="mt-1 text-sm text-slate-400">{{ selected.id }}</p>
        </div>
        <StatusPill :label="selected.status" />
      </div>
      <dl class="mt-4 grid gap-3 md:grid-cols-4">
        <div>
          <dt class="text-xs uppercase text-slate-500">AI Signal</dt>
          <dd class="mt-1 font-medium">{{ aiDecision(selected)?.decision ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Confidence</dt>
          <dd class="mt-1 font-medium">{{ aiDecision(selected)?.confidence ?? '-' }}</dd>
        </div>
        <div class="md:col-span-2">
          <dt class="text-xs uppercase text-slate-500">AI Reasons</dt>
          <dd class="mt-1 font-medium">{{ aiDecision(selected)?.reasons?.join(' ') ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Side</dt>
          <dd class="mt-1 font-medium">{{ selected.side }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Quantity</dt>
          <dd class="mt-1 font-medium">{{ selected.quantity }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Order Type</dt>
          <dd class="mt-1 font-medium">{{ selected.orderType }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Limit</dt>
          <dd class="mt-1 font-medium">{{ selected.limitPrice ? currency(selected.limitPrice) : '-' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Reference</dt>
          <dd class="mt-1 font-medium">{{ currency(selected.referencePrice) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Estimated Notional</dt>
          <dd class="mt-1 font-medium">{{ currency(selected.estimatedNotional) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Entry</dt>
          <dd class="mt-1 font-medium">{{ currency(phase22(selected)?.entry) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Stop Loss</dt>
          <dd class="mt-1 font-medium">{{ currency(phase22(selected)?.stopLoss) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Take Profit</dt>
          <dd class="mt-1 font-medium">{{ currency(phase22(selected)?.takeProfit) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Risk/Reward</dt>
          <dd class="mt-1 font-medium">{{ ratio(phase22(selected)?.riskReward) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Max Loss</dt>
          <dd class="mt-1 font-medium">{{ currency(phase22(selected)?.maxLoss) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Spread</dt>
          <dd class="mt-1 font-medium">{{ percent(phase22(selected)?.spreadPct) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Estimated Slippage</dt>
          <dd class="mt-1 font-medium">{{ percent(phase22(selected)?.estimatedSlippagePct) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Daily Loss Used</dt>
          <dd class="mt-1 font-medium">{{ currency(phase22(selected)?.dailyLossUsed) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Cooldown</dt>
          <dd class="mt-1 font-medium">{{ cooldown(phase22(selected)?.cooldown) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Pending Order Status</dt>
          <dd class="mt-1 font-medium">{{ pendingOrderStatus(phase22(selected)) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Risk Engine Decision</dt>
          <dd class="mt-1 font-medium">{{ selected.riskSnapshot?.result ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Phase 22 Risk Result</dt>
          <dd class="mt-1 font-medium">{{ phase22(selected)?.result ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Created</dt>
          <dd class="mt-1 font-medium">{{ shortDate(selected.createdAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase text-slate-500">Expires</dt>
          <dd class="mt-1 font-medium">{{ shortDate(selected.expiresAt) }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
type Proposal = {
  id: string;
  symbol: string;
  side: string;
  quantity: string;
  orderType: string;
  referencePrice: string;
  limitPrice: string | null;
  estimatedNotional: string;
  riskSnapshot: {
    result?: string;
    aiDecision?: AiDecision;
    phase22?: Phase22Risk;
  } | null;
  createdAt: string;
  expiresAt: string;
  status: string;
};
type AiDecision = {
  decision: string;
  confidence: string;
  reasons: string[];
};
type Phase22Risk = {
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskReward: string;
  maxLoss: string;
  spreadPct: string;
  estimatedSlippagePct: string;
  dailyLossUsed: string;
  result: string;
  conflictingPendingOrders?: unknown[];
  cooldown?: {
    remainingSeconds?: number;
    passed?: boolean;
  };
};
type ProposalList = { proposals: Proposal[] };

const { apiFetch } = useApi();
const route = useRoute();
const message = ref('');
const busy = ref(false);
const selected = ref<Proposal | null>(null);
const { data: proposals, error, refresh } = await useAsyncData<ProposalList>('proposals-page', () => apiFetch('/trade-proposals?limit=50'));

watchEffect(() => {
  const proposalId = typeof route.query.proposalId === 'string' ? route.query.proposalId : '';
  if (!proposalId || selected.value?.id === proposalId) return;
  const proposal = proposals.value?.proposals.find((item) => item.id === proposalId);
  if (proposal) selected.value = proposal;
});

async function approve(id: string) {
  busy.value = true;
  message.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/approve`, { method: 'POST', body: { requestId: crypto.randomUUID() } });
    message.value = 'Proposal approved.';
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function reject(id: string) {
  busy.value = true;
  message.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/reject`, {
      method: 'POST',
      body: { requestId: crypto.randomUUID(), reason: 'Rejected from dashboard' },
    });
    message.value = 'Proposal rejected.';
    await refresh();
  } finally {
    busy.value = false;
  }
}

function currency(value?: string): string {
  return value === undefined ? '-' : `$${Number(value).toFixed(2)}`;
}

function percent(value?: string): string {
  return value === undefined ? '-' : `${Number(value).toFixed(2)}%`;
}

function ratio(value?: string): string {
  return value === undefined ? '-' : `${Number(value).toFixed(2)}:1`;
}

function cooldown(value?: Phase22Risk['cooldown']): string {
  if (!value) return '-';
  return value.passed ? 'Passed' : `${value.remainingSeconds ?? 0}s remaining`;
}

function phase22(proposal: Proposal): Phase22Risk | undefined {
  return proposal.riskSnapshot?.phase22;
}

function aiDecision(proposal: Proposal): AiDecision | undefined {
  return proposal.riskSnapshot?.aiDecision;
}

function pendingOrderStatus(value?: Phase22Risk): string {
  if (!value) return '-';
  return value.conflictingPendingOrders?.length ? 'BLOCKED' : 'CLEAR';
}

function shortDate(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
