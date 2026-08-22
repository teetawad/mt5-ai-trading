<template>
  <div class="space-y-6">
    <header>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">M5 Fast Learning Mode · DEMO ONLY · SHADOW TRADES NEVER PLACE REAL ORDERS</p>
      <h1 class="page-title">Fast Learning</h1>
      <p class="page-subtitle">One AI cycle per completed M5 candle. Every actionable setup automatically becomes a Shadow Trade for data collection — real MT5 DEMO trades still require your manual approval. The AI evaluation dataset combines Shadow and Real Demo outcomes, always kept clearly separate.</p>
    </header>

    <div v-if="errorText" class="notice-error">{{ errorText }}</div>

    <UiCard title="M5 Cycle Status">
      <div class="grid grid-cols-2 gap-3 text-sm text-slate-300 sm:grid-cols-4">
        <div>
          <span class="text-slate-500">Fast Learning Mode</span>
          <p class="text-lg font-bold" :class="status?.enabled ? 'text-emerald-300' : 'text-slate-400'">{{ status?.enabled ? 'ON' : 'OFF' }}</p>
        </div>
        <div><span class="text-slate-500">Last cycle</span><p class="font-semibold text-white">{{ formatDate(status?.lastCycleAt) }}</p></div>
        <div><span class="text-slate-500">Last candle analyzed</span><p class="font-semibold text-white">{{ formatDate(status?.lastCandleTimestamp) }}</p></div>
        <div><span class="text-slate-500">Next expected</span><p class="font-semibold text-white">{{ formatDate(status?.nextExpectedAt) }}</p></div>
      </div>
      <div v-if="status?.lastSummary" class="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-4 text-sm text-slate-300 sm:grid-cols-4">
        <div><span class="text-slate-500">Shortlisted</span><p class="font-semibold text-white">{{ status.lastSummary.aiShortlisted }}</p></div>
        <div><span class="text-slate-500">Actionable</span><p class="font-semibold text-emerald-300">{{ status.lastSummary.actionable }}</p></div>
        <div><span class="text-slate-500">Shadow trades created</span><p class="font-semibold text-sky-300">{{ status.lastSummary.shadowTradesCreated }}</p></div>
        <div><span class="text-slate-500">OpenAI requests used</span><p class="font-semibold text-slate-300">{{ status.lastSummary.openAiRequestsUsed }}</p></div>
      </div>
      <p v-if="status?.lastError" class="mt-3 text-xs text-rose-300">Last cycle error: {{ status.lastError }}</p>
      <p class="mt-3 text-xs text-slate-500">
        FAST_LEARNING_MODE is a server-side environment flag only — there is no frontend toggle, and it never authorizes real MT5 order execution (Shadow Trades only; real DEMO orders still require manual approval).
        <span v-if="status?.enabled === false">Set <code>FAST_LEARNING_MODE=true</code> in the API's environment (e.g. <code>.env</code>) and <strong>restart the API process</strong> to enable automatic cycles — the running server only reads this value once at startup, so editing the environment alone has no effect until it restarts.</span>
        <span v-else>To disable, set <code>FAST_LEARNING_MODE=false</code> and restart the API process — the change takes effect only after restart.</span>
      </p>
      <button class="btn-primary mt-4" :disabled="refreshing" @click="refreshAll">{{ refreshing ? 'Refreshing...' : 'Refresh' }}</button>
    </UiCard>

    <UiCard title="ML Data Readiness" subtitle="Usable completed outcomes from both learning sources — counted separately, combined only for the readiness total.">
      <div class="grid grid-cols-2 gap-3 text-sm text-slate-300 sm:grid-cols-5">
        <div><span class="text-slate-500">Shadow completed</span><p class="text-lg font-bold text-sky-300">{{ readiness?.shadowCompletedSamples ?? '-' }}</p></div>
        <div><span class="text-slate-500">Real Demo completed</span><p class="text-lg font-bold text-emerald-300">{{ readiness?.realDemoCompletedSamples ?? '-' }}</p></div>
        <div><span class="text-slate-500">Total usable</span><p class="text-lg font-bold text-white">{{ readiness?.totalUsableSamples ?? '-' }}</p></div>
        <div><span class="text-slate-500">Recommended minimum</span><p class="font-semibold text-slate-300">{{ readiness?.recommendedMinimumSamples ?? '-' }}</p></div>
        <div>
          <span class="text-slate-500">ML training readiness</span>
          <p class="font-semibold" :class="readiness?.ready ? 'text-emerald-300' : 'text-amber-300'">{{ readiness?.ready ? 'ENOUGH SAMPLES' : 'NOT YET' }}</p>
        </div>
      </div>
      <p class="mt-3 text-xs text-slate-500">A practical sample-size heuristic only — never a claim of statistical significance.</p>
    </UiCard>

    <UiCard title="Today">
      <div v-if="dashboard" class="space-y-4">
        <div class="grid grid-cols-2 gap-3 text-sm text-slate-300 sm:grid-cols-4">
          <div><span class="text-slate-500">M5 decisions</span><p class="font-semibold text-white">{{ dashboard.today.m5Decisions }}</p></div>
          <div><span class="text-slate-500">Shadow setups</span><p class="font-semibold text-white">{{ dashboard.today.shadowSetups }}</p></div>
          <div><span class="text-slate-500">Shadow completed</span><p class="font-semibold text-sky-300">{{ dashboard.today.shadowCompleted }}</p></div>
          <div><span class="text-slate-500">Real Demo completed</span><p class="font-semibold text-emerald-300">{{ dashboard.today.realDemoCompleted }}</p></div>
        </div>
        <div class="grid grid-cols-2 gap-3 border-t border-slate-800 pt-3 text-sm text-slate-300 sm:grid-cols-4">
          <div><span class="text-slate-500">Shadow wins / losses</span><p class="font-semibold"><span class="text-emerald-300">{{ dashboard.today.wins }}</span> / <span class="text-rose-300">{{ dashboard.today.losses }}</span></p></div>
          <div><span class="text-slate-500">Real Demo wins / losses</span><p class="font-semibold"><span class="text-emerald-300">{{ dashboard.today.realDemoWins }}</span> / <span class="text-rose-300">{{ dashboard.today.realDemoLosses }}</span></p></div>
          <div><span class="text-slate-500">Triggered / expired</span><p class="font-semibold text-white">{{ dashboard.today.triggered }} / {{ dashboard.today.expired }}</p></div>
          <div><span class="text-slate-500">Ambiguous (shadow)</span><p class="font-semibold text-slate-400">{{ dashboard.today.ambiguous }}</p></div>
        </div>
        <div class="grid grid-cols-2 gap-3 border-t border-slate-800 pt-3 text-sm text-slate-300 sm:grid-cols-4">
          <div><span class="text-slate-500">Shadow win rate</span><p class="font-semibold text-white">{{ (dashboard.today.winRate * 100).toFixed(1) }}%</p></div>
          <div><span class="text-slate-500">Real Demo win rate</span><p class="font-semibold text-white">{{ (dashboard.today.realDemoWinRate * 100).toFixed(1) }}%</p></div>
          <div><span class="text-slate-500">Shadow average R</span><p class="font-semibold text-white">{{ dashboard.today.averageR !== null ? dashboard.today.averageR.toFixed(2) : '-' }}</p></div>
          <div><span class="text-slate-500">Shadow profit factor</span><p class="font-semibold text-white">{{ dashboard.today.profitFactor !== null ? dashboard.today.profitFactor.toFixed(2) : '-' }}</p></div>
        </div>
      </div>
    </UiCard>

    <UiCard title="All Time" subtitle="Shadow and Real Demo tracked separately; Combined Evaluation is shown only where pooling the two is mathematically meaningful.">
      <div v-if="dashboard" class="grid gap-4 lg:grid-cols-3">
        <div class="rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-4">
          <p class="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-sky-200">
            <span class="rounded-full bg-sky-400/20 px-2 py-0.5">SHADOW · SIMULATED</span>
          </p>
          <dl class="space-y-1.5 text-sm text-slate-300">
            <div class="flex justify-between"><dt class="text-slate-500">Samples</dt><dd class="font-semibold text-white">{{ dashboard.allTime.shadow.samples }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Wins</dt><dd class="font-semibold text-emerald-300">{{ dashboard.allTime.shadow.wins }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Losses</dt><dd class="font-semibold text-rose-300">{{ dashboard.allTime.shadow.losses }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Win rate</dt><dd class="font-semibold text-white">{{ (dashboard.allTime.shadow.winRate * 100).toFixed(1) }}%</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Average R</dt><dd class="font-semibold text-white">{{ dashboard.allTime.shadow.averageR !== null ? dashboard.allTime.shadow.averageR.toFixed(2) : '-' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Profit factor</dt><dd class="font-semibold text-white">{{ dashboard.allTime.shadow.profitFactor !== null ? dashboard.allTime.shadow.profitFactor.toFixed(2) : '-' }}</dd></div>
          </dl>
        </div>
        <div class="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
          <p class="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-emerald-200">
            <span class="rounded-full bg-emerald-400/20 px-2 py-0.5">REAL DEMO · CONFIRMED</span>
          </p>
          <dl class="space-y-1.5 text-sm text-slate-300">
            <div class="flex justify-between"><dt class="text-slate-500">Samples</dt><dd class="font-semibold text-white">{{ dashboard.allTime.realDemo.samples }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Wins</dt><dd class="font-semibold text-emerald-300">{{ dashboard.allTime.realDemo.wins }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Losses</dt><dd class="font-semibold text-rose-300">{{ dashboard.allTime.realDemo.losses }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Win rate</dt><dd class="font-semibold text-white">{{ (dashboard.allTime.realDemo.winRate * 100).toFixed(1) }}%</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Average R</dt><dd class="font-semibold text-white">{{ dashboard.allTime.realDemo.averageR !== null ? dashboard.allTime.realDemo.averageR.toFixed(2) : '-' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Profit factor</dt><dd class="font-semibold text-white">{{ dashboard.allTime.realDemo.profitFactor !== null ? dashboard.allTime.realDemo.profitFactor.toFixed(2) : '-' }}</dd></div>
          </dl>
          <p class="mt-2 text-[11px] text-slate-500">Same rows as History — see <NuxtLink to="/history" class="underline">History</NuxtLink> for the full real DEMO trade record.</p>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Combined Evaluation</p>
          <dl class="space-y-1.5 text-sm text-slate-300">
            <div class="flex justify-between"><dt class="text-slate-500">Total completed</dt><dd class="font-semibold text-white">{{ dashboard.allTime.combined.totalCompletedSamples }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Pooled win rate</dt><dd class="font-semibold text-white">{{ dashboard.allTime.combined.combinedWinRate !== null ? `${(dashboard.allTime.combined.combinedWinRate * 100).toFixed(1)}%` : '-' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-500">Pooled average R</dt><dd class="font-semibold text-white">{{ dashboard.allTime.combined.combinedAverageR !== null ? dashboard.allTime.combined.combinedAverageR.toFixed(2) : '-' }}</dd></div>
          </dl>
          <p class="mt-2 text-[11px] text-slate-500">No combined profit factor: Shadow's net result is a simulated estimate, Real Demo's is actual account currency — pooling those into one dollar figure would misrepresent both.</p>
        </div>
      </div>

      <div v-if="dashboard" class="mt-5 grid gap-4 lg:grid-cols-2">
        <div v-for="section in [{ title: 'Profitability Score Buckets', buckets: dashboard.profitabilityBuckets }, { title: 'Tradeability Buckets', buckets: dashboard.tradeabilityBuckets }]" :key="section.title">
          <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{{ section.title }} <span class="normal-case text-slate-600">(Shadow)</span></p>
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th class="py-1 pr-2">Range</th>
                <th class="py-1 pr-2">Samples</th>
                <th class="py-1 pr-2">Triggered</th>
                <th class="py-1 pr-2">Win Rate</th>
                <th class="py-1 pr-2">Avg R</th>
                <th class="py-1 pr-2">Profit Factor</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="bucket in section.buckets" :key="bucket.bucket" class="border-t border-slate-800/70">
                <td class="py-1 pr-2 font-semibold text-white">{{ bucket.bucket }}</td>
                <td class="py-1 pr-2">{{ bucket.samples }}</td>
                <td class="py-1 pr-2">{{ bucket.triggered }}</td>
                <td class="py-1 pr-2">{{ (bucket.winRate * 100).toFixed(0) }}%</td>
                <td class="py-1 pr-2">{{ bucket.averageR !== null ? bucket.averageR.toFixed(2) : '-' }}</td>
                <td class="py-1 pr-2">{{ bucket.profitFactor !== null ? bucket.profitFactor.toFixed(2) : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="dashboard?.finalQualityBuckets" class="mt-5">
        <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Final Quality Score Buckets <span class="normal-case text-slate-600">(0-49 / 50-64 / 65-79 / 80-100)</span></p>
        <div class="grid gap-4 lg:grid-cols-3">
          <div v-for="fqSection in [{ title: 'SHADOW', buckets: dashboard.finalQualityBuckets.shadow }, { title: 'REAL DEMO', buckets: dashboard.finalQualityBuckets.realDemo }, { title: 'COMBINED', buckets: dashboard.finalQualityBuckets.combined }]" :key="fqSection.title">
            <p class="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-600">{{ fqSection.title }}</p>
            <table class="w-full text-left text-xs text-slate-300">
              <thead class="text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th class="py-1 pr-2">Range</th>
                  <th class="py-1 pr-2">Samples</th>
                  <th class="py-1 pr-2">Win Rate</th>
                  <th class="py-1 pr-2">Avg R</th>
                  <th class="py-1 pr-2">Net P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="bucket in fqSection.buckets" :key="bucket.bucket" class="border-t border-slate-800/70">
                  <td class="py-1 pr-2 font-semibold text-white">{{ bucket.bucket }}</td>
                  <td class="py-1 pr-2">{{ bucket.samples }}</td>
                  <td class="py-1 pr-2">{{ (bucket.winRate * 100).toFixed(0) }}%</td>
                  <td class="py-1 pr-2">{{ bucket.averageR !== null ? bucket.averageR.toFixed(2) : '-' }}</td>
                  <td class="py-1 pr-2">{{ bucket.netPnl !== null ? bucket.netPnl.toFixed(2) : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div v-if="dashboard?.rankPerformance?.length" class="mt-5">
        <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Rank Performance <span class="normal-case text-slate-600">(TOP N vs. lower-ranked setups, pooled Shadow + Real Demo)</span></p>
        <table class="w-full max-w-lg text-left text-xs text-slate-300">
          <thead class="text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-1 pr-2">Rank</th>
              <th class="py-1 pr-2">Samples</th>
              <th class="py-1 pr-2">Win Rate</th>
              <th class="py-1 pr-2">Avg R</th>
              <th class="py-1 pr-2">Net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dashboard.rankPerformance" :key="row.rank" class="border-t border-slate-800/70">
              <td class="py-1 pr-2 font-semibold text-white">#{{ row.rank }}</td>
              <td class="py-1 pr-2">{{ row.samples }}</td>
              <td class="py-1 pr-2">{{ (row.winRate * 100).toFixed(0) }}%</td>
              <td class="py-1 pr-2">{{ row.averageR !== null ? row.averageR.toFixed(2) : '-' }}</td>
              <td class="py-1 pr-2">{{ row.netPnl !== null ? row.netPnl.toFixed(2) : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <EmptyState
      v-if="candidates.length === 0"
      title="NO FAST DEMO CANDIDATES YET"
      message="No completed M5 cycle has produced a Risk-PASS, technically valid setup yet. Enable FAST_LEARNING_MODE and wait for the next completed M5 candle, or run `npm run ai:m5-cycle` for a manual test cycle."
    />
    <UiCard v-else :title="`TOP ${realDemoCandidates.length} REAL DEMO CANDIDATES`" subtitle="Strongest setups this M5 cycle — Final Quality Score >= threshold, Risk-PASS, broker-validated. Still requires your manual click to place any order.">
      <EmptyState v-if="realDemoCandidates.length === 0" title="NO REAL DEMO CANDIDATES THIS CYCLE" message="No setup this cycle met the REAL DEMO Final Quality threshold, or all qualifying setups were blocked by Risk/broker validation. Shadow Learning continues for every valid setup below." />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[1200px] text-left text-sm text-slate-300">
          <thead class="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-2 pr-3">Rank</th>
              <th class="py-2 pr-3">Symbol</th>
              <th class="py-2 pr-3">Side</th>
              <th class="py-2 pr-3">AI Profit.</th>
              <th class="py-2 pr-3">Tradeability</th>
              <th class="py-2 pr-3">Confidence</th>
              <th class="py-2 pr-3">Alignment</th>
              <th class="py-2 pr-3">History</th>
              <th class="py-2 pr-3">Final Quality</th>
              <th class="py-2 pr-3">Tier</th>
              <th class="py-2 pr-3">Entry</th>
              <th class="py-2 pr-3">SL</th>
              <th class="py-2 pr-3">TP</th>
              <th class="py-2 pr-3">R:R</th>
              <th class="py-2 pr-3">Max Loss</th>
              <th class="py-2 pr-3">Target Profit</th>
              <th class="py-2 pr-3">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in realDemoCandidates" :key="row.ai_trade_plan_id ?? `${row.symbol}-${row.rank}`" class="border-t border-slate-800/70">
              <td class="py-2 pr-3 font-semibold text-white">#{{ row.rank }}</td>
              <td class="py-2 pr-3 font-semibold text-white">{{ row.symbol }}</td>
              <td class="py-2 pr-3"><StatusPill :label="row.direction" /></td>
              <td class="py-2 pr-3">{{ row.profitability_score !== null ? Math.round(row.profitability_score) : '-' }}</td>
              <td class="py-2 pr-3">{{ row.tradeability_pct !== null ? `${Math.round(row.tradeability_pct)}%` : '-' }}</td>
              <td class="py-2 pr-3">{{ row.confidence_pct !== null ? `${Math.round(row.confidence_pct)}%` : '-' }}</td>
              <td class="py-2 pr-3">{{ row.multi_timeframe_alignment_score ?? '-' }}</td>
              <td class="py-2 pr-3">{{ row.historical_performance_score ?? '-' }}</td>
              <td class="py-2 pr-3 font-bold" :class="profitabilityClass(row.final_quality_score)">
                {{ row.final_quality_score !== null ? Math.round(row.final_quality_score) : '-' }}/100
                <span v-if="row.historical_adjustment" class="ml-1 text-[10px] font-normal text-rose-300" :title="row.historical_adjustment_reason ?? ''">({{ row.historical_adjustment }})</span>
              </td>
              <td class="py-2 pr-3"><StatusPill :label="row.risk_tier ?? '-'" /></td>
              <td class="py-2 pr-3">{{ priceText(row.entry_price) }}</td>
              <td class="py-2 pr-3 text-rose-200">{{ priceText(row.stop_loss) }}</td>
              <td class="py-2 pr-3 text-emerald-200">{{ priceText(row.take_profit) }}</td>
              <td class="py-2 pr-3">{{ row.risk_reward !== null ? `1:${Number(row.risk_reward).toFixed(2)}` : '-' }}</td>
              <td class="py-2 pr-3 text-rose-200">{{ row.max_loss !== null ? `$${Number(row.max_loss).toFixed(2)}` : '-' }}</td>
              <td class="py-2 pr-3 text-emerald-200">{{ row.target_profit !== null ? `$${Number(row.target_profit).toFixed(2)}` : '-' }}</td>
              <td class="py-2 pr-3">
                <button type="button" class="btn-success text-xs" :disabled="!row.ai_trade_plan_id" @click="openApproveConfirm(row)">
                  PLACE {{ orderTypeLabel(row) }} IN MT5 DEMO
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard v-if="candidates.length > 0" title="Shadow Learning Only" subtitle="Technically valid, still tracked as a Shadow Trade for data collection — just not part of this cycle's REAL DEMO TOP N.">
      <EmptyState v-if="shadowLearningOnly.length === 0" title="NOTHING SHADOW-ONLY THIS CYCLE" message="Every actionable setup this cycle qualified for the REAL DEMO TOP N." />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[900px] text-left text-sm text-slate-300">
          <thead class="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-2 pr-3">Symbol</th>
              <th class="py-2 pr-3">Side</th>
              <th class="py-2 pr-3">AI Profit.</th>
              <th class="py-2 pr-3">Tradeability</th>
              <th class="py-2 pr-3">Confidence</th>
              <th class="py-2 pr-3">Alignment</th>
              <th class="py-2 pr-3">History</th>
              <th class="py-2 pr-3">Final Quality</th>
              <th class="py-2 pr-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shadowLearningOnly" :key="`${row.symbol}-${row.rank}`" class="border-t border-slate-800/70">
              <td class="py-2 pr-3 font-semibold text-white">{{ row.symbol }}</td>
              <td class="py-2 pr-3"><StatusPill :label="row.direction" /></td>
              <td class="py-2 pr-3">{{ row.profitability_score !== null ? Math.round(row.profitability_score) : '-' }}</td>
              <td class="py-2 pr-3">{{ row.tradeability_pct !== null ? `${Math.round(row.tradeability_pct)}%` : '-' }}</td>
              <td class="py-2 pr-3">{{ row.confidence_pct !== null ? `${Math.round(row.confidence_pct)}%` : '-' }}</td>
              <td class="py-2 pr-3">{{ row.multi_timeframe_alignment_score ?? '-' }}</td>
              <td class="py-2 pr-3">{{ row.historical_performance_score ?? '-' }}</td>
              <td class="py-2 pr-3 font-semibold text-slate-300">{{ row.final_quality_score !== null ? Math.round(row.final_quality_score) : '-' }}/100</td>
              <td class="py-2 pr-3 text-xs text-slate-400">{{ row.shadow_only_reason ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Manual confirmation for a TOP N REAL DEMO candidate -->
    <div v-if="approveTarget" class="modal-safe-area fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-0 sm:items-center sm:p-4">
      <section class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-sky-400/40 bg-slate-900 p-5 shadow-2xl sm:rounded-lg">
        <template v-if="!approveOutcome">
          <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Owner confirmation required</p>
          <h2 class="mt-2 text-xl font-semibold text-white">{{ approveTarget.symbol }} — {{ orderTypeLabel(approveTarget) }}</h2>
          <div class="mt-4 grid gap-2 text-sm text-slate-300">
            <div class="flex justify-between"><span>Final Quality</span><strong class="text-white">{{ approveTarget.final_quality_score }}/100 ({{ approveTarget.risk_tier }})</strong></div>
            <div class="flex justify-between"><span>Entry</span><strong>{{ priceText(approveTarget.entry_price) }}</strong></div>
            <div class="flex justify-between"><span>SL</span><strong class="text-rose-200">{{ priceText(approveTarget.stop_loss) }}</strong></div>
            <div class="flex justify-between"><span>TP</span><strong class="text-emerald-200">{{ priceText(approveTarget.take_profit) }}</strong></div>
            <div class="flex justify-between"><span>Planned Max Loss</span><strong class="text-rose-200">{{ approveTarget.max_loss !== null ? `$${Number(approveTarget.max_loss).toFixed(2)}` : '-' }}</strong></div>
            <div class="flex justify-between"><span>Target Profit</span><strong class="text-emerald-200">{{ approveTarget.target_profit !== null ? `$${Number(approveTarget.target_profit).toFixed(2)}` : '-' }}</strong></div>
          </div>
          <p class="mt-3 rounded-lg border border-amber-400/50 bg-amber-400/10 p-3 text-sm font-bold text-amber-100">This places a REAL DEMO order on your connected MT5 DEMO account. DEMO only — real/live execution remains blocked server-side.</p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" @click="closeApproveConfirm">Cancel</button>
            <button class="btn-success" :disabled="approving" @click="confirmApprove">{{ approving ? 'Sending...' : 'Confirm MT5 Demo Order' }}</button>
          </div>
        </template>
        <template v-else>
          <p class="text-xs font-bold uppercase tracking-widest" :class="approveOutcome.allowed ? 'text-emerald-200' : 'text-rose-200'">{{ approveOutcome.allowed ? 'PLACED' : 'NOT PLACED' }}</p>
          <h2 class="mt-1 text-xl font-bold text-white">{{ approveOutcome.code }}</h2>
          <p class="mt-3 text-sm text-slate-300">{{ approveOutcome.reason ?? 'See Open Trades / History for the confirmed result.' }}</p>
          <div class="mt-4 flex justify-end">
            <button class="btn-primary" @click="closeApproveConfirm">Close</button>
          </div>
        </template>
      </section>
    </div>

    <UiCard title="Shadow Trades" subtitle="Simulated only — never a real MT5 order. Always shown separately from real DEMO trades (see Open Trades / History).">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span class="rounded-full bg-sky-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-200">SHADOW · SIMULATED</span>
        <select v-model="shadowStatusFilter" class="field-input max-w-[12rem]" @change="loadShadowTrades">
          <option value="">All statuses</option>
          <option value="AWAITING_TRIGGER">Awaiting trigger</option>
          <option value="ENTERED">Entered</option>
          <option value="EXPIRED_NOT_TRIGGERED">Expired (not triggered)</option>
          <option value="CLOSED">Closed</option>
        </select>
      </div>
      <EmptyState v-if="shadowTrades.length === 0" title="NO SHADOW TRADES YET" message="Shadow trades appear automatically once an M5 cycle produces an actionable setup." />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[820px] text-left text-sm text-slate-300">
          <thead class="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-2 pr-3">Symbol</th>
              <th class="py-2 pr-3">Side</th>
              <th class="py-2 pr-3">Status</th>
              <th class="py-2 pr-3">Order Type</th>
              <th class="py-2 pr-3">Entry</th>
              <th class="py-2 pr-3">Exit</th>
              <th class="py-2 pr-3">Exit Reason</th>
              <th class="py-2 pr-3">R</th>
              <th class="py-2 pr-3">Net Est.</th>
              <th class="py-2 pr-3">MFE / MAE (R)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shadowTrades" :key="row.id" class="border-t border-slate-800/70">
              <td class="py-2 pr-3 font-semibold text-white">{{ row.symbol }}</td>
              <td class="py-2 pr-3"><StatusPill :label="row.direction" /></td>
              <td class="py-2 pr-3"><StatusPill :label="row.status" /></td>
              <td class="py-2 pr-3">{{ row.order_type }}</td>
              <td class="py-2 pr-3">{{ priceText(row.actual_shadow_entry) }}</td>
              <td class="py-2 pr-3">{{ priceText(row.actual_shadow_exit) }}</td>
              <td class="py-2 pr-3">{{ row.exit_reason ?? '-' }}</td>
              <td class="py-2 pr-3" :class="rMultipleClass(row.r_multiple)">{{ row.r_multiple !== null ? Number(row.r_multiple).toFixed(2) : '-' }}</td>
              <td class="py-2 pr-3">{{ row.net_result_estimate !== null ? Number(row.net_result_estimate).toFixed(2) : '-' }}</td>
              <td class="py-2 pr-3 text-xs text-slate-400">{{ row.mfe_r !== null ? Number(row.mfe_r).toFixed(2) : '-' }} / {{ row.mae_r !== null ? Number(row.mae_r).toFixed(2) : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard title="Real Demo Completed Trades" subtitle="Actual MT5-confirmed completed trades, referenced from History for AI evaluation — never a Shadow Trade.">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span class="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">REAL DEMO · CONFIRMED</span>
      </div>
      <EmptyState v-if="realDemoOutcomes.length === 0" title="NO REAL DEMO TRADES COMPLETED YET" message="Completed real MT5 DEMO trades (from manual approval) will appear here once closed. See History for the full record." />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-left text-sm text-slate-300">
          <thead class="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="py-2 pr-3">Symbol</th>
              <th class="py-2 pr-3">Side</th>
              <th class="py-2 pr-3">Result</th>
              <th class="py-2 pr-3">Entry</th>
              <th class="py-2 pr-3">Exit Reason</th>
              <th class="py-2 pr-3">Net PnL</th>
              <th class="py-2 pr-3">R</th>
              <th class="py-2 pr-3">Holding (min)</th>
              <th class="py-2 pr-3">AI Linked</th>
              <th class="py-2 pr-3">Closed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in realDemoOutcomes" :key="row.id" class="border-t border-slate-800/70">
              <td class="py-2 pr-3 font-semibold text-white">{{ row.symbol }}</td>
              <td class="py-2 pr-3"><StatusPill :label="row.direction ?? '-'" /></td>
              <td class="py-2 pr-3"><StatusPill :label="row.result" /></td>
              <td class="py-2 pr-3">{{ priceText(row.entryPrice) }}</td>
              <td class="py-2 pr-3">{{ row.exitReason ?? '-' }}</td>
              <td class="py-2 pr-3" :class="rMultipleClass(row.netPnl)">{{ row.netPnl !== null ? Number(row.netPnl).toFixed(2) : '-' }}</td>
              <td class="py-2 pr-3" :class="rMultipleClass(row.rMultiple)">{{ row.rMultiple !== null ? Number(row.rMultiple).toFixed(2) : '-' }}</td>
              <td class="py-2 pr-3">{{ row.holdingMinutes !== null ? Math.round(row.holdingMinutes) : '-' }}</td>
              <td class="py-2 pr-3">{{ row.aiTradePlanId ? 'Yes' : 'No' }}</td>
              <td class="py-2 pr-3 text-xs text-slate-400">{{ formatDate(row.closedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
type M5ScanSummary = {
  aiShortlisted: number; actionable: number; shadowTradesCreated: number; openAiRequestsUsed: number;
  realDemoEligible?: number; shadowLearningOnly?: number; realDemoMinFinalScore?: number; realDemoTopCandidates?: number;
};
type M5CycleStatus = {
  enabled: boolean; lastCycleAt: string | null; lastCandleTimestamp: string | null;
  lastSummary: M5ScanSummary | null; lastError: string | null; nextExpectedAt: string;
};
type FastDemoCandidate = {
  rank: number; symbol: string; direction: string; action: string; ai_trade_plan_id: string | null;
  profitability_score: number | null; tradeability_pct: number | null; confidence_pct: number | null;
  entry_price: number | null; stop_loss: number | null; take_profit: number | null; risk_reward: number | null;
  risk_result: string | null; max_loss: number | null; target_profit: number | null;
  // Final Quality Score fields (owner spec: REAL DEMO selectivity).
  multi_timeframe_alignment_score: number | null; historical_performance_score: number | null;
  historical_adjustment: number | null; historical_adjustment_reason: string | null;
  final_quality_score: number | null; risk_tier: string | null;
  real_demo_eligible: boolean; shadow_only_reason: string | null;
};
type ShadowTradeRow = {
  id: string; symbol: string; direction: string; status: string; order_type: string;
  actual_shadow_entry: number | null; actual_shadow_exit: number | null; exit_reason: string | null;
  r_multiple: number | null; net_result_estimate: number | null; mfe_r: number | null; mae_r: number | null;
};
type RealDemoOutcomeRow = {
  id: string; aiTradePlanId: string | null; symbol: string; direction: string | null;
  entryPrice: number | null; exitReason: string | null; netPnl: number | null;
  result: string; holdingMinutes: number | null; rMultiple: number | null; closedAt: string | null;
};
type ScoreBucket = { bucket: string; samples: number; triggered: number; winRate: number; averageR: number | null; profitFactor: number | null };
type SourceSummary = { samples: number; wins: number; losses: number; winRate: number; averageR: number | null; profitFactor: number | null };
type CombinedEvaluation = { totalCompletedSamples: number; combinedWinRate: number | null; combinedAverageR: number | null };
type FastLearningDashboard = {
  today: {
    m5Decisions: number; shadowSetups: number; shadowCompleted: number; realDemoCompleted: number;
    triggered: number; expired: number; wins: number; losses: number; ambiguous: number;
    winRate: number; averageR: number | null; profitFactor: number | null; averageMfeR: number | null; averageMaeR: number | null;
    realDemoWins: number; realDemoLosses: number; realDemoWinRate: number;
  };
  allTime: { shadow: SourceSummary; realDemo: SourceSummary; combined: CombinedEvaluation };
  profitabilityBuckets: ScoreBucket[];
  tradeabilityBuckets: ScoreBucket[];
  finalQualityBuckets?: {
    shadow: Array<{ bucket: string; samples: number; winRate: number; averageR: number | null; netPnl: number | null }>;
    realDemo: Array<{ bucket: string; samples: number; winRate: number; averageR: number | null; netPnl: number | null }>;
    combined: Array<{ bucket: string; samples: number; winRate: number; averageR: number | null; netPnl: number | null }>;
  };
  rankPerformance?: Array<{ rank: number; samples: number; winRate: number; averageR: number | null; netPnl: number | null }>;
};
type MlDataReadiness = {
  shadowCompletedSamples: number; realDemoCompletedSamples: number; totalUsableSamples: number;
  recommendedMinimumSamples: number; ready: boolean;
};

const { apiFetch } = useApi();

const errorText = ref('');
const refreshing = ref(false);
const status = ref<M5CycleStatus | null>(null);
const readiness = ref<MlDataReadiness | null>(null);
const dashboard = ref<FastLearningDashboard | null>(null);
const candidates = ref<FastDemoCandidate[]>([]);
const realDemoCandidates = ref<FastDemoCandidate[]>([]);
const shadowLearningOnly = ref<FastDemoCandidate[]>([]);
const shadowTrades = ref<ShadowTradeRow[]>([]);
const shadowStatusFilter = ref('');
const realDemoOutcomes = ref<RealDemoOutcomeRow[]>([]);

// Manual confirmation for placing a TOP N REAL DEMO candidate (spec sections
// 17-22): the owner still has to click through this modal — nothing here
// auto-places an order. approveAndPlaceAiTradePlan on the API side re-checks
// Risk/broker state fresh before ever touching MT5.
const approveTarget = ref<FastDemoCandidate | null>(null);
const approving = ref(false);
const approveOutcome = ref<{ allowed: boolean; code: string | null; reason?: string | null } | null>(null);

function orderTypeLabel(row: FastDemoCandidate): string {
  return `${row.direction} ${row.action === 'ENTER_NOW' ? 'MARKET' : 'PENDING'}`;
}

function openApproveConfirm(row: FastDemoCandidate) {
  approveTarget.value = row;
  approveOutcome.value = null;
}

function closeApproveConfirm() {
  approveTarget.value = null;
  approveOutcome.value = null;
}

async function confirmApprove() {
  if (!approveTarget.value?.ai_trade_plan_id) return;
  approving.value = true;
  try {
    approveOutcome.value = await apiFetch(`/mt5/ai-trade/plans/${approveTarget.value.ai_trade_plan_id}/approve`, { method: 'POST' });
    await refreshAll();
  } catch (err: any) {
    approveOutcome.value = { allowed: false, code: 'REQUEST_FAILED', reason: err?.message ?? 'The request failed.' };
  } finally {
    approving.value = false;
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function priceText(value: number | null): string {
  return value === null || value === undefined ? '-' : Number(value).toFixed(5);
}

function profitabilityClass(score: number | null): string {
  if (score === null) return 'text-slate-400';
  if (score >= 70) return 'text-emerald-300';
  if (score >= 40) return 'text-amber-300';
  return 'text-rose-300';
}

function rMultipleClass(value: number | null): string {
  if (value === null) return 'text-slate-400';
  return value >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

async function loadShadowTrades() {
  const query = shadowStatusFilter.value ? `?status=${encodeURIComponent(shadowStatusFilter.value)}` : '';
  const result = await apiFetch<{ rows: ShadowTradeRow[]; total: number }>(`/mt5/ai-trade/m5/shadow-trades${query}`);
  shadowTrades.value = result.rows;
}

async function refreshAll() {
  refreshing.value = true;
  errorText.value = '';
  try {
    const [statusResult, readinessResult, dashboardResult, candidatesResult, realDemoResult] = await Promise.all([
      apiFetch<M5CycleStatus>('/mt5/ai-trade/m5/status'),
      apiFetch<MlDataReadiness>('/mt5/ai-trade/m5/ml-readiness'),
      apiFetch<FastLearningDashboard>('/mt5/ai-trade/m5/dashboard'),
      apiFetch<{ candidates: FastDemoCandidate[]; realDemoCandidates: FastDemoCandidate[]; shadowLearningOnly: FastDemoCandidate[] }>('/mt5/ai-trade/m5/fast-demo-candidates'),
      apiFetch<{ outcomes: RealDemoOutcomeRow[] }>('/mt5/ai-trade/m5/real-demo-outcomes'),
    ]);
    status.value = statusResult;
    readiness.value = readinessResult;
    dashboard.value = dashboardResult;
    candidates.value = candidatesResult.candidates;
    realDemoCandidates.value = candidatesResult.realDemoCandidates;
    shadowLearningOnly.value = candidatesResult.shadowLearningOnly;
    realDemoOutcomes.value = realDemoResult.outcomes;
    await loadShadowTrades();
  } catch (err: any) {
    errorText.value = err?.message ?? 'Failed to load Fast Learning data.';
  } finally {
    refreshing.value = false;
  }
}

await refreshAll();
</script>
