<template>
  <div class="space-y-6">
    <div>
      <p class="text-xs font-bold uppercase tracking-widest text-amber-200">PAPER TRADING ONLY</p>
      <h1 class="page-title">Trade Proposals</h1>
      <p class="page-subtitle">Review immutable paper proposals. AI Decision explains the model recommendation; Risk Engine Decision controls whether owner approval can proceed.</p>
    </div>

    <div
      v-if="message"
      class="notice-info"
    >
      {{ message }}
    </div>
    <div
      v-if="pageError"
      class="notice-error"
    >
      {{ pageError }}
    </div>

    <div class="grid gap-3 md:grid-cols-3">
      <MetricBox
        label="Pending Approval"
        :value="String(statusCount('PENDING_APPROVAL'))"
        class-name="text-sky-300"
      />
      <MetricBox
        label="Risk Passed at Creation"
        :value="String(riskPassCount)"
        class-name="text-emerald-300"
      />
      <MetricBox
        label="Risk Blocked at Creation"
        :value="String(riskBlockedCount)"
        class-name="text-rose-300"
      />
    </div>

    <UiCard
      title="Proposal Queue"
      subtitle="Click any row to inspect AI, risk, stop, target, and approval details."
      body-class="p-0"
    >
      <template #actions>
        <div class="flex gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1 text-xs font-semibold">
          <button
            v-for="tab in viewTabs"
            :key="tab.value"
            class="rounded-md px-3 py-1.5 transition"
            :class="viewFilter === tab.value ? 'bg-sky-500/20 text-sky-200' : 'text-slate-400 hover:text-slate-200'"
            @click="viewFilter = tab.value"
          >
            {{ tab.label }} ({{ tab.count }})
          </button>
        </div>
      </template>
      <DataTable
        :empty="!filteredProposals.length && !malformedProposals.length"
        :empty-label="viewFilter === 'ACTIVE' ? 'No active proposals awaiting approval or execution' : 'No proposals'"
        :columns="['Symbol', 'Side', 'Qty', 'Reference', 'AI Decision', 'Risk Check (at creation)', 'Status', 'Expires', 'Actions']"
      >
        <tr
          v-for="proposal in filteredProposals"
          :key="proposal.id"
          class="cursor-pointer border-t border-slate-800/80 hover:bg-slate-800/40"
          :class="selected?.id === proposal.id ? 'bg-sky-400/5' : ''"
          @click="selected = proposal"
        >
          <td class="px-4 py-3 font-semibold text-white">
            <div class="flex items-center gap-2">
              <span>{{ proposal.symbol }}</span>
              <StatusPill :label="proposal.assetClass" />
            </div>
          </td>
          <td class="px-4 py-3">{{ proposal.side }}</td>
          <td class="px-4 py-3 tabular-nums">{{ proposal.quantity }}</td>
          <td class="px-4 py-3 tabular-nums">{{ currency(proposal.referencePrice) }}</td>
          <td class="px-4 py-3"><StatusPill :label="String(aiDecision(proposal)?.decision ?? 'NO_AI')" /></td>
          <td class="px-4 py-3"><StatusPill :label="proposal.riskSnapshot?.result ?? 'UNKNOWN'" /></td>
          <td class="px-4 py-3"><StatusPill :label="proposal.status" /></td>
          <td class="px-4 py-3 text-slate-400">{{ shortDate(proposal.expiresAt) }}</td>
          <td class="px-4 py-3">
            <div class="flex justify-end gap-2">
              <button
                class="btn-success"
                :disabled="proposal.status !== 'PENDING_APPROVAL' || busy"
                @click.stop="approve(proposal.id)"
              >
                Approve
              </button>
              <button
                class="btn-danger"
                :disabled="proposal.status !== 'PENDING_APPROVAL' || busy"
                @click.stop="reject(proposal.id)"
              >
                Reject
              </button>
            </div>
          </td>
        </tr>
        <tr
          v-for="malformed in malformedProposals"
          :key="`malformed-${malformed.id}`"
          class="border-t border-slate-800 bg-rose-500/5"
        >
          <td
            colspan="8"
            class="px-4 py-3 text-rose-200"
          >
            Proposal {{ malformed.id }} ({{ malformed.status }}) has malformed data and cannot be displayed safely.
          </td>
          <td class="px-4 py-3 text-right text-xs font-semibold text-rose-300">Needs attention</td>
        </tr>
      </DataTable>
    </UiCard>

    <UiCard
      v-if="selected"
      :title="`${selected.symbol} Proposal Detail`"
      :subtitle="selected.id"
    >
      <template #actions>
        <StatusPill :label="selected.status" />
      </template>
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div class="grid w-full gap-4 lg:grid-cols-2">
          <div class="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-4">
            <p class="text-xs font-bold uppercase tracking-widest text-emerald-300">AI Decision</p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <StatusPill :label="String(aiDecision(selected)?.decision ?? 'NO_AI')" />
              <span class="text-sm text-slate-300">Confidence {{ aiDecision(selected)?.confidence ?? '-' }}</span>
            </div>
            <p class="mt-3 text-sm leading-6 text-slate-300">{{ aiReasons(selected) }}</p>
          </div>
          <div class="rounded-lg border border-sky-400/30 bg-sky-400/10 p-4">
            <p class="text-xs font-bold uppercase tracking-widest text-sky-300">Risk Engine Decision</p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <StatusPill :label="selected.riskSnapshot?.result ?? 'UNKNOWN'" />
              <StatusPill :label="String(phase22(selected)?.result ?? 'NO_PHASE22')" />
            </div>
            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <ProgressMeter
                label="Risk/Reward"
                :percent="riskRewardPercent(selected)"
                :value-label="ratio(phase22(selected)?.riskReward)"
                status-label="R/R"
              />
              <ProgressMeter
                label="Daily Loss Used"
                :percent="dailyLossPercent(selected)"
                :value-label="currency(phase22(selected)?.dailyLossUsed)"
                status-label="LIMIT"
              />
            </div>
          </div>
        </div>
      </div>
      <dl class="mt-4 grid gap-3 md:grid-cols-4">
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
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type Proposal = {
  id: string;
  symbol: string;
  assetClass: 'STOCK' | 'CRYPTO';
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
  decision?: unknown;
  confidence?: unknown;
  reasons?: unknown;
};
type Phase22Risk = {
  entry?: unknown;
  stopLoss?: unknown;
  takeProfit?: unknown;
  riskReward?: unknown;
  maxLoss?: unknown;
  spreadPct?: unknown;
  estimatedSlippagePct?: unknown;
  dailyLossUsed?: unknown;
  result?: unknown;
  conflictingPendingOrders?: unknown[];
  cooldown?: {
    remainingSeconds?: number;
    passed?: boolean;
  };
};
type ProposalList = { proposals: Proposal[] };

// Statuses where a proposal has finished its lifecycle — it will never
// transition again (see apps/api/src/services/proposal-state-machine.ts).
// Everything else is still "active": either awaiting a decision or still
// mid-execution. Used to keep the default queue view free of historical
// rows instead of interleaving them by creation time only.
const TERMINAL_STATUSES = new Set([
  'RISK_REJECTED',
  'OWNER_REJECTED',
  'EXPIRED',
  'RISK_REJECTED_AFTER_APPROVAL',
  'FILLED',
  'CANCELLED',
  'EXECUTION_REJECTED',
  'EXECUTION_ERROR',
]);

const { apiFetch } = useApi();
const route = useRoute();
const message = ref('');
const actionError = ref('');
const busy = ref(false);
const selected = ref<Proposal | null>(null);
const viewFilter = ref<'ACTIVE' | 'HISTORICAL' | 'ALL'>('ACTIVE');
const { data: proposals, error, refresh } = await useAsyncData<ProposalList>('proposals-page', () => apiFetch('/trade-proposals?limit=50'));
useAutoRefresh(refresh, 5000);
const safeProposals = computed(() => {
  const list = proposals.value?.proposals;
  if (!Array.isArray(list)) return [];
  return list.filter(isRenderableProposal);
});
const activeProposals = computed(() => safeProposals.value.filter((proposal) => !TERMINAL_STATUSES.has(proposal.status)));
const historicalProposals = computed(() => safeProposals.value.filter((proposal) => TERMINAL_STATUSES.has(proposal.status)));
const viewTabs = computed(() => [
  { value: 'ACTIVE' as const, label: 'Active', count: activeProposals.value.length },
  { value: 'HISTORICAL' as const, label: 'Historical', count: historicalProposals.value.length },
  { value: 'ALL' as const, label: 'All', count: safeProposals.value.length },
]);
const filteredProposals = computed(() => {
  if (viewFilter.value === 'ACTIVE') return activeProposals.value;
  if (viewFilter.value === 'HISTORICAL') return historicalProposals.value;
  return safeProposals.value;
});
const malformedProposals = computed(() => {
  const list = proposals.value?.proposals;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => !isRenderableProposal(item))
    .map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        id: stringValue(record.id) ?? 'unknown-id',
        status: stringValue(record.status) ?? 'UNKNOWN',
      };
    });
});
const pageError = computed(() => {
  if (actionError.value) return actionError.value;
  if (error.value) return error.value.message;
  const raw = proposals.value?.proposals;
  if (raw !== undefined && !Array.isArray(raw)) {
    return 'Trade proposal API returned an invalid proposals list.';
  }
  const invalidCount = malformedProposals.value.length;
  if (invalidCount > 0) {
    return `${invalidCount} malformed proposal${invalidCount === 1 ? '' : 's'} shown below cannot be fully displayed — still pending your attention.`;
  }
  return '';
});
const riskPassCount = computed(() => safeProposals.value.filter((proposal) => String(proposal.riskSnapshot?.result ?? '').includes('PASS')).length);
const riskBlockedCount = computed(() => safeProposals.value.filter((proposal) => {
  const result = String(proposal.riskSnapshot?.result ?? '');
  return result.includes('FAIL') || result.includes('REJECT') || result.includes('BLOCK');
}).length);

watchEffect(() => {
  const proposalId = typeof route.query.proposalId === 'string' ? route.query.proposalId : '';
  if (!proposalId || selected.value?.id === proposalId) return;
  const proposal = safeProposals.value.find((item) => item.id === proposalId);
  if (proposal) selected.value = proposal;
});

watch(safeProposals, (list) => {
  if (!selected.value) return;
  selected.value = list.find((proposal) => proposal.id === selected.value?.id) ?? null;
});

async function approve(id: string) {
  busy.value = true;
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/approve`, { method: 'POST', body: { requestId: crypto.randomUUID() } });
    message.value = 'Proposal approved.';
    await refresh();
  } catch (err) {
    actionError.value = errorMessage(err, 'Failed to approve proposal.');
  } finally {
    busy.value = false;
  }
}

async function reject(id: string) {
  busy.value = true;
  message.value = '';
  actionError.value = '';
  try {
    await apiFetch(`/trade-proposals/${id}/reject`, {
      method: 'POST',
      body: { requestId: crypto.randomUUID(), reason: 'Rejected from dashboard' },
    });
    message.value = 'Proposal rejected.';
    await refresh();
  } catch (err) {
    actionError.value = errorMessage(err, 'Failed to reject proposal.');
  } finally {
    busy.value = false;
  }
}

function isRenderableProposal(value: unknown): value is Proposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<Proposal>;
  return typeof proposal.id === 'string'
    && typeof proposal.symbol === 'string'
    && typeof proposal.side === 'string'
    && typeof proposal.quantity === 'string'
    && typeof proposal.orderType === 'string'
    && typeof proposal.referencePrice === 'string'
    && typeof proposal.estimatedNotional === 'string'
    && typeof proposal.createdAt === 'string'
    && typeof proposal.expiresAt === 'string'
    && typeof proposal.status === 'string';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function currency(value?: unknown): string {
  const text = stringValue(value);
  if (!text) return '-';
  const number = Number(text);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-';
}

function percent(value?: unknown): string {
  const text = stringValue(value);
  if (!text) return '-';
  const number = Number(text);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : '-';
}

function ratio(value?: unknown): string {
  const text = stringValue(value);
  if (!text) return '-';
  const number = Number(text);
  return Number.isFinite(number) ? `${number.toFixed(2)}:1` : '-';
}

function cooldown(value?: Phase22Risk['cooldown']): string {
  if (!value) return '-';
  return value.passed ? 'Passed' : `${value.remainingSeconds ?? 0}s remaining`;
}

function phase22(proposal: Proposal): Phase22Risk | undefined {
  const value = proposal.riskSnapshot?.phase22;
  return value && typeof value === 'object' ? value : undefined;
}

function aiDecision(proposal: Proposal): AiDecision | undefined {
  const value = proposal.riskSnapshot?.aiDecision;
  return value && typeof value === 'object' ? value : undefined;
}

function aiReasons(proposal: Proposal): string {
  const reasons = aiDecision(proposal)?.reasons;
  if (Array.isArray(reasons)) {
    const text = reasons.filter((reason): reason is string => typeof reason === 'string').join(' ');
    return text || '-';
  }
  if (typeof reasons === 'string' && reasons.trim()) return reasons;
  return '-';
}

function pendingOrderStatus(value?: Phase22Risk): string {
  if (!value) return '-';
  return value.conflictingPendingOrders?.length ? 'BLOCKED' : 'CLEAR';
}

function statusCount(status: string): number {
  return safeProposals.value.filter((proposal) => proposal.status === status).length;
}

function dailyLossPercent(proposal: Proposal): number {
  const risk = phase22(proposal);
  const used = numeric(risk?.dailyLossUsed);
  const limit = numeric(risk?.maxLoss);
  return limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
}

function riskRewardPercent(proposal: Proposal): number {
  return Math.min(100, (numeric(phase22(proposal)?.riskReward) / 3) * 100);
}

function numeric(value?: unknown): number {
  const text = stringValue(value);
  const parsed = Number(text ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortDate(value: string): string {
  return new Date(value).toLocaleString();
}
</script>
