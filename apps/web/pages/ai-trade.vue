<template>
  <div class="space-y-6">
    <header>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">AI Trading Decision Engine · DEMO ONLY</p>
      <h1 class="page-title">AI Trade</h1>
      <p class="page-subtitle">Select a market. The engine analyzes it and returns one clear structured decision — no chat, no back-and-forth.</p>
    </header>

    <div v-if="providerConfigured === false" class="notice-error">
      <p class="font-bold uppercase tracking-wide">AI PROVIDER NOT CONFIGURED</p>
      <p class="mt-1">Set TRADING_AI_PROVIDER, TRADING_AI_MODEL, and the matching API key in the environment, then restart the API.</p>
    </div>
    <div v-if="errorText" class="notice-error">{{ errorText }}</div>
    <div v-if="invalidPlanMessage" class="notice-error">
      <p class="font-bold uppercase tracking-wide">TRADE PLAN INVALID</p>
      <p class="mt-1">{{ invalidPlanMessage }}</p>
    </div>

    <UiCard title="Choose what you want AI to analyze">
      <div class="grid gap-3 lg:grid-cols-[10rem_1fr_14rem]">
        <select v-model="assetFilter" class="field-input">
          <option v-for="asset in availableAssets" :key="asset" :value="asset">{{ asset === 'ALL' ? 'All asset classes' : labelAsset(asset) }}</option>
        </select>
        <input v-model="search" class="field-input" placeholder="Search symbol, e.g. SGDJPY, XAUUSD, BTCUSD">
        <select v-model="selectedSymbol" class="field-input">
          <option value="" disabled>Select a symbol...</option>
          <option v-for="instrument in filteredInstruments" :key="instrument.symbol" :value="instrument.symbol">
            {{ instrument.symbol }} — {{ labelAsset(instrument.asset_class) }}
          </option>
        </select>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button class="btn-success" :disabled="!selectedSymbol || busy || providerConfigured === false" @click="analyze">
          {{ busy ? 'Analyzing...' : 'ANALYZE WITH AI' }}
        </button>
        <button class="btn-primary" :disabled="scanning || providerConfigured === false" @click="findBestTrades">
          {{ scanning ? 'Scanning...' : 'FIND BEST TRADES' }}
        </button>
      </div>
      <p v-if="scanning" class="mt-3 text-sm text-sky-300">{{ scanProgressMessage }}</p>
    </UiCard>

    <UiCard v-if="scanCapacity" title="DEMO ACCOUNT CAPACITY">
      <div class="grid grid-cols-2 gap-3 text-sm text-slate-300 sm:grid-cols-4">
        <div>
          <span class="text-slate-500">Open positions</span>
          <p class="text-lg font-bold" :class="scanCapacity.availablePositionSlots > 0 ? 'text-white' : 'text-rose-300'">{{ scanCapacity.openPositions }} / {{ scanCapacity.maxSimultaneousPositions }}</p>
        </div>
        <div><span class="text-slate-500">Available slots</span><p class="text-lg font-bold text-white">{{ scanCapacity.availablePositionSlots }}</p></div>
        <div><span class="text-slate-500">Pending orders</span><p class="text-lg font-bold text-white">{{ scanCapacity.pendingOrders }}</p></div>
        <div>
          <span class="text-slate-500">Trades today</span>
          <p class="text-lg font-bold" :class="scanCapacity.tradesToday >= scanCapacity.maxTradesPerDay ? 'text-rose-300' : 'text-white'">{{ scanCapacity.tradesToday }} / {{ scanCapacity.maxTradesPerDay }}</p>
        </div>
        <div><span class="text-slate-500">Free margin</span><p class="text-lg font-bold text-white">{{ scanCapacity.freeMargin !== null ? `$${scanCapacity.freeMargin.toFixed(2)}` : '-' }}</p></div>
        <div v-if="scanSummary"><span class="text-slate-500">AI plans found</span><p class="text-lg font-bold text-emerald-300">{{ scanSummary.actionable }}</p></div>
        <div v-if="scanSummary"><span class="text-slate-500">Executable now</span><p class="text-lg font-bold text-emerald-300">{{ scanSummary.riskPass }}</p></div>
        <div v-if="scanSummary"><span class="text-slate-500">Risk blocked</span><p class="text-lg font-bold text-rose-300">{{ scanSummary.riskBlocked }}</p></div>
      </div>
      <p class="mt-3 text-xs text-slate-500">
        {{ scanCapacity.fastLearningRiskProfileEnabled ? 'DEMO Fast Learning risk profile is ON — position/loss limits are loosened for this verified DEMO account.' : 'DEMO Fast Learning risk profile is OFF — using standard conservative limits.' }}
        {{ scanCapacity.demoVerified ? '' : ' MT5 demo account is not currently verified — loosened limits are not in effect.' }}
      </p>
    </UiCard>

    <UiCard v-if="scanSummary" title="Scan Summary">
      <div class="grid grid-cols-2 gap-3 text-sm text-slate-300 sm:grid-cols-4">
        <div><span class="text-slate-500">MT5 symbols discovered</span><p class="text-lg font-bold text-white">{{ scanSummary.symbolsDiscovered }}</p></div>
        <div><span class="text-slate-500">Data valid</span><p class="text-lg font-bold text-white">{{ scanSummary.dataValid }}</p></div>
        <div><span class="text-slate-500">Shortlisted</span><p class="text-lg font-bold text-white">{{ scanSummary.aiShortlisted }}</p></div>
        <div><span class="text-slate-500">Valid trade plans</span><p class="text-lg font-bold text-emerald-300">{{ scanSummary.actionable }}</p></div>
        <div><span class="text-slate-500">Risk PASS</span><p class="font-semibold text-emerald-300">{{ scanSummary.riskPass }}</p></div>
        <div><span class="text-slate-500">Risk BLOCKED</span><p class="font-semibold text-rose-300">{{ scanSummary.riskBlocked }}</p></div>
        <div><span class="text-slate-500">Technical blocked</span><p class="font-semibold text-amber-300">{{ scanSummary.technicalBlocked }}</p></div>
        <div><span class="text-slate-500">AI provider errors</span><p class="font-semibold" :class="scanSummary.aiProviderErrors ? 'text-rose-400' : 'text-slate-300'">{{ scanSummary.aiProviderErrors }}</p></div>
        <div><span class="text-slate-500">Top opportunities shown</span><p class="font-semibold text-white">{{ scanSummary.topOpportunitiesShown }}</p></div>
        <div><span class="text-slate-500">ENTER_NOW</span><p class="font-semibold text-white">{{ scanSummary.enterNow }}</p></div>
        <div><span class="text-slate-500">WAIT_FOR_ENTRY</span><p class="font-semibold text-white">{{ scanSummary.waitForEntry }}</p></div>
        <div><span class="text-slate-500">OpenAI requests used</span><p class="font-semibold text-sky-300">{{ scanSummary.openAiRequestsUsed }}</p></div>
        <div v-if="scanSummary.reusedFromCache"><span class="text-slate-500">Reused (same candle)</span><p class="font-semibold text-slate-300">{{ scanSummary.reusedFromCache }}</p></div>
        <div><span class="text-slate-500">BUY LIMIT valid plans</span><p class="font-semibold text-white">{{ scanSummary.buyLimitValidCount }}</p></div>
        <div><span class="text-slate-500">Other order types (valid, not BUY LIMIT)</span><p class="font-semibold text-white">{{ scanSummary.otherOrderTypeValidCount }}</p></div>
      </div>

      <div v-if="Object.keys(scanSummary.technicalBlockBreakdown).length" class="mt-4 border-t border-slate-800 pt-3">
        <p class="text-xs font-bold uppercase tracking-wide text-amber-300">Technical Blocked Breakdown</p>
        <ul class="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-300 sm:grid-cols-3">
          <li v-for="(count, code) in scanSummary.technicalBlockBreakdown" :key="code">{{ code }}: <strong class="text-white">{{ count }}</strong></li>
        </ul>
      </div>
      <div v-if="Object.keys(scanSummary.aiProviderErrorBreakdown).length" class="mt-3 border-t border-slate-800 pt-3">
        <p class="text-xs font-bold uppercase tracking-wide text-rose-400">AI Provider Error Breakdown</p>
        <p class="mt-0.5 text-[11px] text-slate-500">These say nothing about setup quality — the AI was never successfully consulted for these symbols this scan.</p>
        <ul class="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-300 sm:grid-cols-3">
          <li v-for="(count, code) in scanSummary.aiProviderErrorBreakdown" :key="code">{{ code }}: <strong class="text-white">{{ count }}</strong></li>
        </ul>
      </div>
    </UiCard>

    <EmptyState
      v-if="scanSummary && scanResults.length === 0"
      title="NO EXECUTABLE BUY LIMIT OPPORTUNITIES"
      :message="`No executable BUY LIMIT opportunities found right now.${scanOtherIdeas.length ? ` ${scanOtherIdeas.length} other AI idea${scanOtherIdeas.length === 1 ? '' : 's'} ${scanOtherIdeas.length === 1 ? 'is' : 'are'} blocked or not executable now — see “Other AI plans” below.` : ''}`"
    />

    <UiCard v-else-if="scanResults.length" title="Top 10 Executable BUY LIMIT Opportunities" subtitle="Ranked by AI Profitability. Every card here already passed the Risk Engine, is not a stale/already-processed plan, and passed a live MT5 broker preflight — never a blocked or non-BUY_LIMIT setup.">
      <p class="mb-4 text-xs text-slate-400">Executable MT5 DEMO opportunities found: {{ scanResults.length }}</p>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="(row, index) in scanResults"
          :key="row.symbol"
          class="relative flex flex-col rounded-lg border p-4 text-left transition"
          :class="index < 3 ? 'border-emerald-400/50 bg-emerald-400/[0.06] shadow-[0_0_0_1px_rgba(52,211,153,0.15)]' : 'border-slate-800 bg-slate-950/70'"
        >
          <div class="flex items-start justify-between gap-2">
            <div>
              <span
                class="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                :class="index === 0 ? 'bg-emerald-400 text-slate-950' : index < 3 ? 'bg-emerald-400/20 text-emerald-200' : 'bg-slate-800 text-slate-400'"
              >
                {{ index === 0 ? '#1 AI BEST OPPORTUNITY' : `#${index + 1}` }}
              </span>
              <p class="mt-1 font-semibold text-white">{{ row.symbol }} <span class="font-normal text-slate-500">· {{ labelAsset(row.assetClass) }}</span></p>
            </div>
            <span v-if="row.reused" class="text-[10px] uppercase tracking-wide text-slate-500" title="Reused from a recent analysis on the same completed candle">cached</span>
          </div>

          <div class="mt-2 flex flex-wrap gap-1">
            <StatusPill :label="row.decision" />
            <StatusPill v-if="row.action" :label="scanActionLabel(row.action)" />
            <StatusPill :label="scanOrderTypeLabel(row)" />
          </div>

          <div class="mt-3">
            <p class="text-[10px] font-bold uppercase tracking-wide text-slate-500">AI Profitability · โอกาสทำกำไรตามการประเมินของ AI</p>
            <p v-if="row.profitabilityScore !== null" class="text-2xl font-bold" :class="profitabilityClass(row.profitabilityScore)">
              AI Profitability: {{ Math.round(row.profitabilityScore) }}/100
            </p>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-slate-400">
            <span>Tradeability: <strong :class="row.tradeabilityPct !== null ? tradeabilityClass(row.tradeabilityPct) : ''">{{ row.tradeabilityPct !== null ? `${Math.round(row.tradeabilityPct)}%` : '-' }}</strong></span>
            <span>Confidence: {{ formatConfidencePct(row.confidencePct) }}</span>
          </div>

          <div class="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 border-t border-slate-800 pt-2 text-xs text-slate-300">
            <span>Current: {{ priceText(row.currentPrice) }}</span>
            <span>Entry: {{ priceText(row.entryPrice) }}</span>
            <span class="text-rose-200">SL: {{ priceText(row.stopLoss) }}</span>
            <span class="text-emerald-200">TP: {{ priceText(row.takeProfit) }}</span>
            <span v-if="row.riskReward !== null">R:R 1:{{ row.riskReward.toFixed(2) }}</span>
            <span>Expiry: {{ formatDate(row.planExpiry) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-x-2 text-xs">
            <span class="text-rose-200">Max Loss: {{ money(row.maxLoss) }}</span>
            <span class="text-emerald-200">Target Profit: {{ money(row.targetProfit) }}</span>
          </div>

          <p class="mt-2 text-xs font-bold uppercase tracking-wide text-emerald-300">DEMO EXECUTION: READY</p>

          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="btn-primary flex-1 text-xs" @click="selectFromScan(row.symbol)">VIEW PLAN</button>
            <button type="button" class="btn-success flex-1 text-xs" :disabled="scanning" @click="placeFromScan(row.symbol)">
              PLACE BUY LIMIT IN MT5 DEMO
            </button>
          </div>
        </div>
      </div>
    </UiCard>

    <UiCard v-if="scanOtherIdeas.length" title="Other AI plans (blocked / not executable now)">
      <details>
        <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
          Show {{ scanOtherIdeas.length }} blocked / not-yet-executable AI idea{{ scanOtherIdeas.length === 1 ? '' : 's' }} (debug)
        </summary>
        <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div v-for="row in scanOtherIdeas" :key="row.symbol" class="relative flex flex-col rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-left">
            <p class="font-semibold text-white">{{ row.symbol }} <span class="font-normal text-slate-500">· {{ labelAsset(row.assetClass) }}</span></p>
            <div class="mt-2 flex flex-wrap gap-1">
              <StatusPill :label="row.decision" />
              <StatusPill v-if="row.action" :label="scanActionLabel(row.action)" />
              <StatusPill :label="scanOrderTypeLabel(row)" />
            </div>
            <p v-if="row.profitabilityScore !== null" class="mt-2 text-sm font-semibold" :class="profitabilityClass(row.profitabilityScore)">
              AI Profitability: {{ Math.round(row.profitabilityScore) }}/100
            </p>
            <p class="mt-2 text-xs font-bold uppercase tracking-wide" :class="row.executableNow ? 'text-emerald-300' : 'text-rose-300'">
              DEMO EXECUTION: {{ row.executableNow ? 'READY (not BUY LIMIT)' : 'BLOCKED' }}
            </p>
            <ul v-if="row.blockReasons?.length" class="mt-1 space-y-0.5 text-[11px] text-rose-200">
              <li v-for="rule in row.blockReasons" :key="rule">• {{ rule.replaceAll('_', ' ') }}</li>
            </ul>
            <p v-if="row.blockReasons?.includes('INSUFFICIENT_MARGIN') && row.marginRequired" class="mt-1 text-[11px] text-rose-200">
              Required {{ money(row.marginRequired) }} · Free {{ money(row.freeMargin) }} · Shortfall {{ money(row.marginShortfall) }}
            </p>
            <template v-if="row.blockReasons?.includes('POSITION_EXISTS')">
              <p class="mt-1 text-[11px] font-semibold uppercase tracking-wide text-rose-200">REAL DEMO: BLOCKED — POSITION ALREADY EXISTS</p>
              <p class="text-[11px] font-semibold uppercase tracking-wide" :class="row.shadowTradeActive ? 'text-sky-300' : 'text-slate-500'">
                SHADOW LEARNING: {{ row.shadowTradeActive ? 'ACTIVE' : 'NOT CREATED' }}
              </p>
            </template>
            <p v-if="row.error" class="mt-2 text-xs text-rose-300">{{ row.error }}</p>
            <button type="button" class="btn-primary mt-3 text-xs" @click="selectFromScan(row.symbol)">VIEW PLAN</button>
          </div>
        </div>
      </details>
    </UiCard>

    <!-- TECHNICAL DIAGNOSTICS (spec: expose the EXACT reason a shortlisted
         symbol never became a valid trade plan, never a blanket "Technical
         blocked"). Genuine technical-impossibility rows only — AI provider
         failures (auth/billing/rate-limit/timeout) are shown separately
         below since they mean something completely different: the AI was
         never even reached, not that the setup was invalid. -->
    <UiCard v-if="scanDiagnostics.length" title="Technical Diagnostics">
      <details>
        <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-amber-300">
          Show {{ scanDiagnostics.length }} technically blocked symbol{{ scanDiagnostics.length === 1 ? '' : 's' }} (exact reason per symbol)
        </summary>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full min-w-[720px] text-left text-xs text-slate-300">
            <thead class="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th class="py-1 pr-3">Symbol</th>
                <th class="py-1 pr-3">Block Code</th>
                <th class="py-1 pr-3">Message</th>
                <th class="py-1 pr-3">Current</th>
                <th class="py-1 pr-3">Entry</th>
                <th class="py-1 pr-3">SL</th>
                <th class="py-1 pr-3">TP</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scanDiagnostics" :key="row.symbol" class="border-t border-slate-800/70">
                <td class="py-1 pr-3 font-semibold text-white">{{ row.symbol }}</td>
                <td class="py-1 pr-3 font-semibold text-amber-300">{{ row.technicalBlockCode ?? 'UNKNOWN_ERROR' }}</td>
                <td class="py-1 pr-3">{{ row.technicalBlockMessage ?? row.error ?? '-' }}</td>
                <td class="py-1 pr-3">{{ priceText(row.currentPrice) }}</td>
                <td class="py-1 pr-3">{{ priceText(row.entryPrice) }}</td>
                <td class="py-1 pr-3 text-rose-200">{{ priceText(row.stopLoss) }}</td>
                <td class="py-1 pr-3 text-emerald-200">{{ priceText(row.takeProfit) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </UiCard>

    <!-- AI PROVIDER ERRORS: distinct from Technical Diagnostics above — the
         AI service itself could not be reached/billed/parsed for these
         symbols this scan; retrying later (or fixing the account/config) is
         what resolves these, not adjusting any trade plan. -->
    <UiCard v-if="scanAiErrors.length" title="AI Provider Errors">
      <p class="mb-2 text-xs text-slate-500">The AI was never successfully consulted for these symbols this scan — this is not a statement about setup quality.</p>
      <details>
        <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-rose-400">
          Show {{ scanAiErrors.length }} AI provider error{{ scanAiErrors.length === 1 ? '' : 's' }}
        </summary>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full min-w-[560px] text-left text-xs text-slate-300">
            <thead class="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th class="py-1 pr-3">Symbol</th>
                <th class="py-1 pr-3">Error Code</th>
                <th class="py-1 pr-3">Message</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scanAiErrors" :key="row.symbol" class="border-t border-slate-800/70">
                <td class="py-1 pr-3 font-semibold text-white">{{ row.symbol }}</td>
                <td class="py-1 pr-3 font-semibold text-rose-400">{{ row.technicalBlockCode ?? 'UNKNOWN_ERROR' }}</td>
                <td class="py-1 pr-3">{{ row.technicalBlockMessage ?? row.error ?? '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </UiCard>

    <UiCard v-if="plan" :title="`${plan.symbol} — ${plan.assetClass}`">
      <template #actions>
        <div class="flex gap-2">
          <StatusPill :label="marketLabel" />
          <StatusPill :label="plan.market.dataStatus" />
          <StatusPill :label="plan.action.action" />
        </div>
      </template>

      <!-- AI DECISION -->
      <div class="grid gap-6 lg:grid-cols-2">
        <div>
          <p class="text-xs font-bold uppercase tracking-widest text-slate-500">ทิศทาง AI (AI Direction)</p>
          <p class="mt-2 text-4xl font-bold" :class="decisionClass">{{ plan.decision.direction }}</p>
          <p class="mt-2 text-sm text-slate-400">มั่นใจแค่ไหน? (AI Confidence): <strong class="text-white">{{ formatConfidencePct(plan.decision.confidencePct) }}</strong></p>
          <p class="mt-3 text-xs font-bold uppercase tracking-widest text-slate-500">Action</p>
          <p class="mt-1 text-2xl font-bold" :class="actionClass">{{ actionLabel }}</p>
        </div>
        <div class="rounded-lg border p-4" :class="tradeabilityBorderClass">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-500">ความน่าเทรด? (Tradeability)</p>
          <p class="mt-2 text-4xl font-bold" :class="tradeabilityClass(plan.tradeability.tradeabilityPct)">{{ Math.round(plan.tradeability.tradeabilityPct) }}%</p>
          <p class="mt-1 text-lg font-semibold text-white">{{ plan.tradeability.ratingLabelTh }}</p>
          <p class="mt-2 text-xs leading-5 text-slate-400">
            How attractive this setup looks — never a probability of profit, never the Risk Engine result. A low value is still a valid DEMO plan, just flagged as lower quality.
          </p>
        </div>
      </div>

      <div v-if="plan.action.action === 'ENTER_NOW' || plan.action.action === 'WAIT_FOR_ENTRY'">
        <div v-if="plan.tradeability.tradeabilityPct < 30" class="mt-6 rounded-lg border border-rose-400/60 bg-rose-400/10 p-4">
          <p class="text-sm font-bold uppercase tracking-wide text-rose-200">⚠ VERY LOW-QUALITY DEMO SETUP</p>
          <p class="mt-1 text-sm text-rose-100">Tradeability is very low ({{ Math.round(plan.tradeability.tradeabilityPct) }}%). Still a technically valid DEMO plan — never automatically blocked — but review carefully before confirming.</p>
        </div>
        <div v-else-if="plan.tradeability.tradeabilityPct < 50" class="mt-6 rounded-lg border border-amber-400/50 bg-amber-400/10 p-4">
          <p class="text-sm font-bold uppercase tracking-wide text-amber-200">LOW-QUALITY DEMO SETUP</p>
          <p class="mt-1 text-sm text-amber-100">Tradeability is below 50% ({{ Math.round(plan.tradeability.tradeabilityPct) }}%). Still DEMO-actionable — only a quality flag, not a block.</p>
        </div>
      </div>

      <EmptyState
        v-if="isClosed"
        class="mt-6"
        title="MARKET CLOSED"
        message="AI analyzed historical chart context, but order placement is disabled while this market is closed."
      />

      <EmptyState
        v-else-if="plan.action.action === 'NO_EXECUTION'"
        class="mt-6"
        title="NO EXECUTION — TECHNICAL BLOCK ONLY"
        :message="plan.explanation.summary || 'A valid order could not be constructed (invalid/missing data), not a quality judgment.'"
      />

      <template v-else>
        <div
          v-if="plan.action.action === 'WAIT_FOR_ENTRY'"
          class="mt-6 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-4"
        >
          <p class="text-sm font-bold uppercase tracking-wide text-emerald-200">VALID SETUP — WAITING FOR BETTER ENTRY</p>
          <p class="mt-1 text-sm text-emerald-100">AI recommends waiting for a better price before entering (pending order).</p>
        </div>

        <div class="mt-6 grid gap-4 lg:grid-cols-2">
          <UiCard title="เข้าตอนไหน? (When to Enter)" body-class="p-4">
            <div class="grid gap-2 text-sm text-slate-300">
              <div class="flex justify-between"><span>Order type</span><strong class="text-white">{{ orderTypeLabel }}</strong></div>
              <div class="flex justify-between"><span>Current</span><strong>{{ priceText(plan.quote.currentPrice) }}</strong></div>
              <div v-if="!plan.entryPlan.entry_zone_low" class="flex justify-between"><span>เข้าที่ราคาไหน? (Entry)</span><strong>{{ priceText(entryPriceText) }}</strong></div>
              <div v-else class="flex justify-between"><span>Entry Zone</span><strong>{{ priceText(plan.entryPlan.entry_zone_low) }} – {{ priceText(plan.entryPlan.entry_zone_high) }}</strong></div>
              <div v-if="plan.entryPlan.entry_type === 'BREAKOUT'" class="flex justify-between"><span>Trigger Price</span><strong>{{ priceText(plan.entryPlan.trigger_price) }}</strong></div>
              <div class="flex justify-between"><span>Plan expires</span><strong>{{ formatDate(plan.entryPlan.plan_expiry) }}</strong></div>
            </div>
          </UiCard>
          <UiCard title="ต้องใช้กี่ Lot? (How Much)" body-class="p-4">
            <div class="grid gap-2 text-sm text-slate-300">
              <div class="flex justify-between"><span>Final lot</span><strong>{{ numberText(plan.positionSizing.recommendedLotSize) }}</strong></div>
              <div class="flex justify-between"><span>เสียได้สูงสุดเท่าไหร่? (Max loss)</span><strong class="text-rose-200">{{ money(plan.positionSizing.maximumPlannedLoss) }}</strong></div>
              <div class="flex justify-between"><span>Target profit</span><strong class="text-emerald-200">{{ money(plan.positionSizing.targetProfit) }}</strong></div>
            </div>
          </UiCard>
          <UiCard title="Protection (SL / TP)" body-class="p-4">
            <div class="grid gap-2 text-sm text-slate-300">
              <div class="flex justify-between"><span>SL อยู่ไหน?</span><strong class="text-rose-200">{{ priceText(plan.protection.stopLoss) }}</strong></div>
              <div class="flex justify-between"><span>TP อยู่ไหน?</span><strong class="text-emerald-200">{{ priceText(plan.protection.takeProfit) }}</strong></div>
              <div class="flex justify-between"><span>Risk / Reward</span><strong>1 : {{ numberText(plan.protection.riskReward) }}</strong></div>
            </div>
          </UiCard>
          <UiCard title="Risk Engine อนุญาตไหม?" body-class="p-4">
            <StatusPill :label="riskLabel" />
            <ul v-if="riskFailedRules.length" class="mt-2 space-y-1 text-xs text-rose-200">
              <li v-for="rule in riskFailedRules" :key="rule">• {{ rule.replaceAll('_', ' ') }}</li>
            </ul>
          </UiCard>
        </div>

        <UiCard class="mt-4" title="ทำไม AI ถึงเลือกแบบนี้? (Why This Is Interesting)" body-class="p-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">AI Reason</p>
          <ul class="mt-1 space-y-1 text-sm text-slate-300">
            <li v-for="(bullet, i) in plan.explanation.bullets" :key="i">- {{ bullet }}</li>
          </ul>
          <template v-if="plan.explanation.risks.length">
            <p class="mt-4 text-xs font-semibold uppercase tracking-wide text-amber-400">Risks</p>
            <ul class="mt-1 space-y-1 text-sm text-amber-200">
              <li v-for="(riskItem, i) in plan.explanation.risks" :key="i">- {{ riskItem }}</li>
            </ul>
          </template>
          <template v-if="plan.tradeScore">
            <p class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Trade Score (secondary diagnostic, not the primary quality signal)</p>
            <div class="mt-1 grid gap-1 text-sm text-slate-400 sm:max-w-xs">
              <div class="flex justify-between"><span>Trade Score</span><strong>{{ Math.round(plan.tradeScore.tradeScore) }}/100 ({{ plan.tradeScore.tradeRatingLabelTh }})</strong></div>
            </div>
          </template>
        </UiCard>

        <div class="mt-6 flex flex-wrap items-center gap-3">
          <button class="btn-success" :disabled="!canPlaceOrder || approving" @click="showConfirm = true">
            {{ approving ? 'Sending to MT5...' : placeButtonLabel }}
          </button>
          <span v-if="!canPlaceOrder" class="text-xs text-slate-500">{{ blockReason }}</span>
        </div>
      </template>

      <details class="mt-6 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
        <summary class="cursor-pointer text-xs font-bold uppercase tracking-wide text-slate-500">Advanced Details</summary>
        <div class="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
          <span>Plan ID: {{ plan.planId ?? '-' }}</span>
          <span>Plan status: {{ plan.planStatus ?? '-' }}</span>
          <span>Market condition: {{ plan.decision.marketCondition || '-' }}</span>
          <span>Trend: {{ plan.decision.trend }}</span>
          <span>Bid/Ask: {{ priceText(plan.quote.bid) }} / {{ priceText(plan.quote.ask) }}</span>
          <span>Spread: {{ priceText(plan.quote.spread) }}</span>
          <span>Action reason: {{ plan.action.reason }}</span>
        </div>
        <div v-if="plan.debug" class="mt-3 grid gap-2 border-t border-slate-800 pt-3 text-xs text-slate-500 sm:grid-cols-2">
          <span>Raw AI confidence: {{ plan.debug.rawConfidence }}</span>
          <span>Normalized confidence: {{ plan.debug.normalizedConfidencePct }}%</span>
        </div>
      </details>
    </UiCard>

    <!-- Confirmation -->
    <div v-if="showConfirm && plan" class="modal-safe-area fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-0 sm:items-center sm:p-4">
      <section class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-sky-400/40 bg-slate-900 p-5 shadow-2xl sm:rounded-lg">
        <template v-if="!approveOutcome">
          <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Owner confirmation required</p>
          <h2 class="mt-2 text-xl font-semibold text-white">{{ confirmTitle }}</h2>
          <p class="mt-3 rounded-lg border border-amber-400/50 bg-amber-400/10 p-3 text-sm font-bold text-amber-100">
            THIS WILL {{ plan.entryPlan.entry_type === 'MARKET_NOW' ? 'OPEN A REAL POSITION' : 'CREATE A REAL PENDING ORDER' }} INSIDE THE CONNECTED MT5 DEMO ACCOUNT.
          </p>
          <p v-if="plan.tradeability.tradeabilityPct < 50" class="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-2 text-xs font-semibold text-amber-200">
            Tradeability is {{ Math.round(plan.tradeability.tradeabilityPct) }}% ({{ plan.tradeability.ratingLabelTh }}) — a lower-quality DEMO setup.
          </p>
          <div class="mt-4 grid gap-2 text-sm text-slate-300">
            <div class="flex justify-between"><span>Entry</span><strong>{{ priceText(entryPriceText) }}</strong></div>
            <div class="flex justify-between"><span>Volume</span><strong>{{ numberText(plan.positionSizing.recommendedLotSize) }} lot</strong></div>
            <div class="flex justify-between"><span>Stop Loss</span><strong class="text-rose-200">{{ priceText(plan.protection.stopLoss) }}</strong></div>
            <div class="flex justify-between"><span>Take Profit</span><strong class="text-emerald-200">{{ priceText(plan.protection.takeProfit) }}</strong></div>
            <div class="flex justify-between"><span>Maximum planned loss</span><strong class="text-rose-200">{{ money(plan.positionSizing.maximumPlannedLoss) }}</strong></div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" @click="showConfirm = false">Cancel</button>
            <button class="btn-success" :disabled="approving" @click="confirmPlace">{{ approving ? 'Sending...' : 'Confirm MT5 Demo Order' }}</button>
          </div>
        </template>
        <template v-else-if="approveOutcome.code === 'PENDING_CONFIRMATION'">
          <div class="rounded-lg border border-sky-400/50 bg-sky-400/10 p-3">
            <p class="text-xs font-bold uppercase tracking-widest text-sky-200">CONFIRMING WITH MT5...</p>
            <h2 class="mt-1 text-xl font-bold text-sky-100">Request sent to MT5</h2>
          </div>
          <p class="mt-3 text-sm text-slate-300">
            Request was sent. The system is checking MT5 for the real order.
          </p>
          <div class="mt-4 flex items-center gap-3 rounded-lg border border-sky-400/30 bg-sky-400/10 p-3">
            <span class="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
            <span class="text-sm text-sky-200">Checking MT5 orders, positions, and history for the real result…</span>
          </div>
          <p class="mt-3 text-xs text-slate-400">No duplicate order will be sent while this is in progress.</p>
          <template v-if="confirmationTimedOut">
            <p class="mt-3 text-sm font-semibold text-amber-300">Still checking in the background. You can close this and check Open Trades / History for the result.</p>
            <div class="mt-3 flex justify-end gap-2">
              <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" @click="closeConfirm">Close</button>
              <NuxtLink to="/positions" class="btn-success">View Open Trades</NuxtLink>
            </div>
          </template>
        </template>
        <template v-else-if="approveOutcome.allowed">
          <div class="rounded-lg border border-emerald-400/50 bg-emerald-400/10 p-3">
            <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">{{ successStatusLabel }}</p>
            <h2 class="mt-1 text-xl font-bold text-emerald-100">
              {{ approveOutcome.code === 'ALREADY_PLACED' ? 'ALREADY PLACED IN MT5' : successHeadline }}
            </h2>
          </div>
          <p class="mt-3 text-sm text-slate-300">{{ successDescription }}</p>
          <div class="mt-4 grid gap-2 text-sm text-slate-300">
            <div class="flex justify-between"><span>Symbol</span><strong class="text-white">{{ plan.symbol }}</strong></div>
            <div class="flex justify-between"><span>Order type</span><strong class="text-white">{{ orderTypeLabel }}</strong></div>
            <div class="flex justify-between"><span>{{ isPendingOrderSuccess ? 'MT5 Ticket' : 'Position Ticket' }}</span><strong class="text-white">{{ approveOutcome.plan?.mt5_order_ticket ?? approveOutcome.plan?.mt5_position_ticket ?? '-' }}</strong></div>
            <div class="flex justify-between"><span>Entry</span><strong>{{ priceText(entryPriceText) }}</strong></div>
            <div class="flex justify-between"><span>SL</span><strong class="text-rose-200">{{ priceText(plan.protection.stopLoss) }}</strong></div>
            <div class="flex justify-between"><span>TP</span><strong class="text-emerald-200">{{ priceText(plan.protection.takeProfit) }}</strong></div>
            <div class="flex justify-between"><span>Volume</span><strong>{{ numberText(plan.positionSizing.recommendedLotSize) }} lot</strong></div>
            <div v-if="isPendingOrderSuccess" class="flex justify-between"><span>Expiration</span><strong>{{ formatDate(plan.entryPlan.plan_expiry) }}</strong></div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" @click="closeConfirm">Close</button>
            <NuxtLink to="/positions" class="btn-success">View Open Trades</NuxtLink>
          </div>
        </template>
        <template v-else>
          <div class="rounded-lg border border-rose-400/50 bg-rose-400/10 p-3">
            <p class="text-xs font-bold uppercase tracking-widest text-rose-200">PENDING ORDER NOT PLACED</p>
            <h2 class="mt-1 text-xl font-bold text-rose-100">{{ failureHeadline }}</h2>
          </div>
          <p class="mt-3 text-sm text-slate-300">
            Broker message: {{ approveOutcome.reason ?? 'No MT5 order was created.' }}
          </p>
          <div v-if="failureDiagnostics" class="mt-3 grid gap-1 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
            <template v-if="failureDiagnostics.orderSendMissing">
              <p class="text-rose-300">MT5 ORDER SEND FAILED — no trade-server result was returned.</p>
              <div class="flex justify-between"><span>MT5 library error</span><strong class="text-white">{{ failureDiagnostics.lastErrorCode ?? '-' }} {{ failureDiagnostics.lastErrorMessage ?? '' }}</strong></div>
            </template>
            <template v-else>
              <div v-if="failureDiagnostics.retcode !== null" class="flex justify-between"><span>MT5 Retcode</span><strong class="text-white">{{ failureDiagnostics.retcode }} — {{ failureDiagnostics.retcodeName }}</strong></div>
              <div v-else class="flex justify-between"><span>MT5 Retcode</span><strong class="text-white">MT5 RESULT MISSING RETCODE</strong></div>
              <p v-if="failureDiagnostics.retcodeIsNonstandardZero" class="text-amber-300">
                This broker returns 0 as a non-standard code (never a documented MT5 retcode).
                It is not treated as accepted — MT5 could not confirm any resulting order, position, or history.
              </p>
              <template v-if="failureDiagnostics.orderSendAttempted">
                <div v-if="failureDiagnostics.comment !== null" class="flex justify-between"><span>Broker comment</span><strong class="text-white">{{ failureDiagnostics.comment }}</strong></div>
                <div class="flex justify-between"><span>Order ticket</span><strong class="text-white">{{ failureDiagnostics.order ?? 'N/A' }}</strong></div>
                <div class="flex justify-between"><span>Deal ticket</span><strong class="text-white">{{ failureDiagnostics.deal ?? 'N/A' }}</strong></div>
                <div v-if="failureDiagnostics.requestId !== null" class="flex justify-between"><span>Request ID</span><strong class="text-white">{{ failureDiagnostics.requestId }}</strong></div>
              </template>
              <p v-else class="text-amber-300">order_send was not attempted (rejected at order_check).</p>
            </template>
          </div>
          <p class="mt-3 text-sm font-semibold text-rose-300">No MT5 order was created.</p>
          <p class="mt-1 text-sm font-semibold text-emerald-300">No duplicate order was sent.</p>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" @click="closeConfirm">Close</button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type InstrumentRow = { symbol: string; asset_class: string; description?: string | null };
type TradeScorePayload = {
  tradeScore: number;
  tradeRating: string;
  tradeRatingLabelTh: string;
  breakdown: { trend: number; momentum: number; entryQuality: number; riskReward: number; marketConditions: number };
};
type TradeabilityPayload = { tradeabilityPct: number; rating: string; ratingLabelTh: string };
type AiActionPayload = { action: string; reason: string; orderIntent: string | null };
type AiTradePlanDetail = {
  symbol: string;
  assetClass: string;
  market: { status: string; dataStatus: string };
  quote: { bid: number | null; ask: number | null; currentPrice: number | null; spread: number | null };
  decision: { direction: string; confidencePct: number; trend: string; marketCondition: string };
  action: AiActionPayload;
  tradeability: TradeabilityPayload;
  // Kept only as a secondary, dataset-comparison diagnostic — never the
  // primary quality display (see tradeability above).
  tradeScore: TradeScorePayload | null;
  entryPlan: Record<string, any>;
  protection: { stopLoss: number | null; takeProfit: number | null; riskReward: number | null };
  positionSizing: Record<string, any>;
  risk: { result: string | null; label: string; failedRules?: string[] };
  explanation: { title: string; summary: string; bullets: string[]; risks: string[] };
  planId: string | null;
  planStatus: string | null;
  debug?: { rawConfidence: unknown; normalizedConfidencePct: number } | null;
};
type ScanRow = {
  symbol: string; assetClass: string; decision: string; action: string | null; actionReason: string | null;
  confidencePct: number | null; tradeabilityPct: number | null; tradeabilityRating: string | null; tradeabilityRatingLabelTh: string | null;
  profitabilityScore: number | null;
  tradeScore: number | null; tradeRating: string | null; tradeRatingLabelTh: string | null;
  entryType: string | null; pendingOrderType: string | null;
  currentPrice: number | null; entryPrice: number | null; stopLoss: number | null; takeProfit: number | null;
  planExpiry: string | null; planId: string | null;
  riskResult: string | null; riskFailedRules: string[] | null; riskReward: number | null;
  maxLoss: string | null; targetProfit: string | null;
  marginRequired: string | null; freeMargin: string | null; marginShortfall: string | null;
  error: string | null; reused: boolean;
  shadowTradeActive: boolean; shadowTradeStatus: string | null;
  side: string; demoExecutionReady: boolean; blockReasons: string[]; brokerPreflightPass: boolean; executableNow: boolean;
  // Technical validation diagnostics (regression fix: every row now carries
  // an exact reason instead of collapsing into a generic "Technical blocked").
  technicalValid: boolean; technicalBlockCode: string | null; technicalBlockMessage: string | null;
};
type ScanSummary = {
  symbolsDiscovered: number; dataValid: number; aiShortlisted: number; actionable: number;
  enterNow: number; waitForEntry: number; technicalBlocked: number; riskPass: number; riskBlocked: number;
  openAiRequestsUsed: number; reusedFromCache: number; topOpportunitiesShown: number;
  technicalBlockBreakdown: Record<string, number>;
  aiProviderErrors: number; aiProviderErrorBreakdown: Record<string, number>;
  aiPlanValid: number; buyLimitValidCount: number; otherOrderTypeValidCount: number;
};
type ScanCapacity = {
  demoVerified: boolean; openPositions: number; maxSimultaneousPositions: number; availablePositionSlots: number;
  pendingOrders: number; tradesToday: number; maxTradesPerDay: number;
  freeMargin: number | null; equity: number | null; fastLearningRiskProfileEnabled: boolean;
};
type ScanResponse = { scanId: string; summary: ScanSummary; topOpportunities: ScanRow[]; actionable: ScanRow[]; otherIdeas: ScanRow[]; rejected: ScanRow[]; aiErrors: ScanRow[]; capacity: ScanCapacity };

const { apiFetch } = useApi();

const providerConfigured = ref<boolean | null>(null);
const busy = ref(false);
const scanning = ref(false);
const approving = ref(false);
const errorText = ref('');
const invalidPlanMessage = ref('');
const search = ref('');
const assetFilter = ref('ALL');
const selectedSymbol = ref('');
const plan = ref<AiTradePlanDetail | null>(null);
// TOP N AI trade opportunities (spec sections 10/11/13/14/16) — already
// ranked by AI Profitability and Risk-PASS-preferred server-side
// (runOpportunityScan); never re-filtered/re-sorted client-side.
const scanResults = ref<ScanRow[]>([]);
const scanOtherIdeas = ref<ScanRow[]>([]);
const scanDiagnostics = ref<ScanRow[]>([]);
const scanAiErrors = ref<ScanRow[]>([]);
const scanSummary = ref<ScanSummary | null>(null);
const scanCapacity = ref<ScanCapacity | null>(null);
const scanProgressMessage = ref('Discovering MT5 markets...');
const showConfirm = ref(false);
const approveOutcome = ref<{ allowed: boolean; code: string | null; reason?: string; plan?: Record<string, any> | null } | null>(null);
// The trading engine's own synchronous check is now intentionally fast
// (perf fix) — when it can't confirm the real MT5 order/position within its
// short window, the API returns PENDING_CONFIRMATION immediately instead of
// blocking, and a background pass keeps checking server-side. This polls
// the plan's status while that background pass is in flight, WITHOUT ever
// resubmitting the order.
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 9_000; // comfortable margin over the ~3.3s server-side background window
const confirmationTimedOut = ref(false);
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
async function pollPlanStatus(planId: string, deadline: number) {
  if (approveOutcome.value?.code !== 'PENDING_CONFIRMATION') return; // resolved or modal closed already
  try {
    approveOutcome.value = await apiFetch(`/mt5/ai-trade/plans/${planId}/status`);
  } catch {
    // Transient polling failure — never treated as a definite outcome; just
    // try again on the next tick within the same bounded deadline.
  }
  if (approveOutcome.value?.code !== 'PENDING_CONFIRMATION') return;
  if (Date.now() < deadline) {
    pollTimer = setTimeout(() => pollPlanStatus(planId, deadline), POLL_INTERVAL_MS);
    return;
  }
  // Deadline passed while still PENDING_CONFIRMATION — never fabricated
  // into a failure. The server-side background pass (and, as an ultimate
  // safety net, the existing 120s stuck-submission watcher) is still
  // resolving it; just stop polling and let the owner close the modal and
  // check Open Trades/History instead of staying stuck on a spinner.
  confirmationTimedOut.value = true;
}
onUnmounted(stopPolling);

const { data: instrumentsData } = await useAsyncData<{ instruments: InstrumentRow[] }>('ai-trade-instruments', () => apiFetch('/mt5/instruments'), { lazy: true });
const instruments = computed(() => instrumentsData.value?.instruments ?? []);
const availableAssets = computed(() => ['ALL', ...new Set(instruments.value.map((i) => i.asset_class).filter(Boolean))]);
const filteredInstruments = computed(() => {
  const term = search.value.trim().toLowerCase();
  return instruments.value.filter((i) => {
    const matchesAsset = assetFilter.value === 'ALL' || i.asset_class === assetFilter.value;
    const matchesSearch = !term || i.symbol.toLowerCase().includes(term);
    return matchesAsset && matchesSearch;
  });
});

onMounted(async () => {
  try {
    const status = await apiFetch<{ configured: boolean }>('/mt5/ai-trade/status');
    providerConfigured.value = status.configured;
  } catch {
    providerConfigured.value = null;
  }
});

const isClosed = computed(() => plan.value?.market.status !== 'CONNECTED');
const marketLabel = computed(() => isClosed.value ? 'MARKET UNAVAILABLE' : 'MT5 CONNECTED');
const decisionClass = computed(() => {
  const direction = plan.value?.decision.direction;
  if (direction === 'BUY') return 'text-emerald-300';
  if (direction === 'SELL') return 'text-rose-300';
  return 'text-amber-200';
});
const ACTION_LABELS: Record<string, string> = { ENTER_NOW: 'ENTER NOW', WAIT_FOR_ENTRY: 'WAIT FOR ENTRY', NO_EXECUTION: 'NO EXECUTION' };
const actionLabel = computed(() => {
  const action = plan.value?.action.action;
  return action ? ACTION_LABELS[action] ?? action : '-';
});
const actionClass = computed(() => {
  const action = plan.value?.action.action;
  if (action === 'ENTER_NOW') return 'text-emerald-300';
  if (action === 'WAIT_FOR_ENTRY') return 'text-sky-300';
  return 'text-slate-400';
});
const entryPriceText = computed(() => plan.value?.entryPlan.entry_price ?? plan.value?.entryPlan.trigger_price ?? plan.value?.entryPlan.entry_zone_high ?? null);
const orderTypeLabel = computed(() => {
  const type = plan.value?.entryPlan.pending_order_type;
  if (!type || type === 'NONE') return `MARKET ${plan.value?.decision.direction}`;
  return type.replaceAll('_', ' ');
});
const placeButtonLabel = computed(() => `PLACE ${orderTypeLabel.value} IN MT5 DEMO`);
const confirmTitle = computed(() => `${plan.value?.symbol} ${orderTypeLabel.value}`);
// The real, post-approval plan status is the only source of truth for what
// actually happened — never inferred from the AI's original entry_type. A
// PULLBACK/BREAKOUT plan can legitimately end as POSITION_OPEN if MT5
// triggered it immediately (spec: "IMMEDIATE TRIGGER CASE"), and that must
// never be shown as "pending order placed".
const isPendingOrderSuccess = computed(() => approveOutcome.value?.plan?.status === 'PENDING_ORDER_PLACED');
const isImmediateTrigger = computed(() => approveOutcome.value?.plan?.status === 'POSITION_OPEN' && plan.value?.entryPlan.entry_type !== 'MARKET_NOW');
const successStatusLabel = computed(() => {
  if (isPendingOrderSuccess.value) return 'MT5 PENDING ORDER CONFIRMED';
  if (isImmediateTrigger.value) return 'ORDER TRIGGERED';
  return 'MT5 POSITION CONFIRMED';
});
const successHeadline = computed(() => {
  if (isPendingOrderSuccess.value) return 'DEMO PENDING ORDER PLACED';
  if (isImmediateTrigger.value) return 'POSITION OPEN IN MT5 DEMO';
  return 'DEMO POSITION OPENED';
});
const successDescription = computed(() => {
  if (isPendingOrderSuccess.value) return 'MT5 is now waiting for the planned entry price.';
  if (isImmediateTrigger.value) return 'The price condition was already met — MT5 filled the order immediately and the demo position is now open.';
  return 'The demo position is now open in MT5.';
});
const failureHeadline = computed(() => {
  // blockPlan() always returns code=EXECUTION_FAILED/RISK_BLOCKED/
  // ORDER_CANCELLED (the status it transitioned to) — the SPECIFIC reason
  // lives on the plan's own blocked_reason, which is what distinguishes
  // "not confirmed" from "ambiguous" from "rejected" from "cancelled" for
  // this UI. A definite history-proven cancellation is never shown as
  // "not confirmed" — those mean different things (spec section 7/8).
  const reason = approveOutcome.value?.plan?.blocked_reason;
  if (reason === 'PENDING_ORDER_NOT_CONFIRMED') return 'PENDING ORDER NOT CONFIRMED';
  if (reason === 'PENDING_ORDER_CONFIRMATION_AMBIGUOUS') return 'PENDING ORDER CONFIRMATION AMBIGUOUS';
  if (reason === 'PENDING_ORDER_CANCELLED') return 'PENDING ORDER CANCELLED BY BROKER';
  if (reason === 'PENDING_ORDER_REJECTED') return 'PENDING ORDER REJECTED';
  // No MqlTradeResult ever came back from the trade server (spec section
  // 2/5/11) — an infrastructure/IPC failure, never a trade-server
  // rejection, so it gets its own distinct headline rather than being
  // shown as a generic "not sent".
  if (reason === 'MT5_ORDER_SEND_RETURNED_NONE') return 'MT5 ORDER SEND FAILED';
  return 'DEMO ORDER NOT SENT';
});
// The exact MqlTradeResult diagnostics captured server-side (spec: never
// show vague "appeared accepted" once the real retcode is known, and never
// invent a value for a field MT5 never actually returned). Two possible
// shapes land here: the engine's own {request, order_check, order_send}
// object (a failure raised inside execute_pending_order), or the flat
// success-shape snapshot (retcode/order/deal/... at the top level, from the
// rare "accepted but no ticket" branch within the success path).
const failureDiagnostics = computed(() => {
  const snap = approveOutcome.value?.plan?.execution_snapshot as Record<string, any> | undefined;
  if (!snap) return null;
  const send = snap.order_send ?? (snap.retcode !== undefined ? snap : null);
  const check = snap.order_check ?? null;
  const info = send ?? check;
  if (!info) return null;
  return {
    retcode: info.retcode ?? null,
    retcodeName: info.retcode !== null && info.retcode !== undefined ? (info.retcode_name ?? 'MISSING RETCODE NAME') : null,
    // order/deal/request_id only ever exist on a REAL order_send result.
    // When order_send never returned one (order_check-only rejection, or a
    // None result — see orderSendMissing below), these must stay null —
    // never a fake 0 that reads as "MT5 returned ticket zero" (spec
    // section 5/10).
    orderSendAttempted: send !== null,
    order: send ? (send.order ?? null) : null,
    deal: send ? (send.deal ?? null) : null,
    requestId: send ? (send.request_id ?? null) : null,
    // The broker's own comment text — the actual discriminator between a
    // genuine "Done" and a real rejection when retcode alone is ambiguous
    // (this broker's undocumented retcode 0). Captured server-side since
    // the diagnostics were first added, but never previously surfaced here.
    comment: info.comment ?? null,
    // Set by the adapter when send.retcode was literally 0 — this broker's
    // own non-standard code (the real MT5 enum starts at 10004). Unlike a
    // documented retcode, there is no evidence this ever means "placed" for
    // a PENDING order once independent reconciliation finds nothing, so the
    // UI must never present it as if it behaves like a normal result.
    retcodeIsNonstandardZero: send?.retcode_is_broker_nonstandard_zero === true,
    // Set specifically by the MT5_ORDER_SEND_RETURNED_NONE path (spec
    // section 9): the Python MT5 library/IPC error channel, never the
    // trade-server retcode channel — must never be mixed with retcode.
    lastErrorCode: snap.last_error_code ?? null,
    lastErrorMessage: snap.last_error_message ?? null,
    orderSendMissing: snap.order_send === undefined && (snap.last_error_code !== undefined || snap.last_error_message !== undefined),
  };
});
const riskLabel = computed(() => plan.value?.risk.result === 'PASS' ? 'RISK CHECK: PASS' : 'TRADE BLOCKED');
const riskFailedRules = computed(() => plan.value?.risk.failedRules ?? []);
// Gated only by Risk Engine PASS + plan status + market open — NEVER by
// tradeability_pct (spec: "Execution button must be available regardless of
// tradeability_pct as long as plan+geometry+Risk PASS+DEMO verified").
const canPlaceOrder = computed(() => Boolean(plan.value?.planId) && plan.value?.risk.result === 'PASS' && plan.value?.planStatus === 'WAITING_FOR_APPROVAL' && !isClosed.value);
const blockReason = computed(() => {
  if (!plan.value) return '';
  if (plan.value.risk.result !== 'PASS') return 'Risk Engine blocked this plan.';
  if (plan.value.planStatus && plan.value.planStatus !== 'WAITING_FOR_APPROVAL') return `Plan is ${plan.value.planStatus}.`;
  return '';
});
const tradeabilityBorderClass = computed(() => {
  const pct = plan.value?.tradeability?.tradeabilityPct;
  if (pct === undefined || pct === null) return 'border-slate-800 bg-slate-950/70';
  if (pct >= 85) return 'border-emerald-400/50 bg-emerald-400/10';
  if (pct >= 70) return 'border-sky-400/40 bg-sky-400/10';
  if (pct >= 50) return 'border-amber-400/40 bg-amber-400/10';
  if (pct >= 30) return 'border-orange-400/40 bg-orange-400/10';
  return 'border-rose-400/50 bg-rose-400/10';
});

function tradeabilityClass(pct: number) {
  if (pct >= 85) return 'text-emerald-300';
  if (pct >= 70) return 'text-sky-300';
  if (pct >= 50) return 'text-amber-300';
  if (pct >= 30) return 'text-orange-300';
  return 'text-rose-300';
}

async function analyze() {
  if (!selectedSymbol.value) return;
  busy.value = true;
  errorText.value = '';
  invalidPlanMessage.value = '';
  plan.value = null;
  try {
    plan.value = await apiFetch<AiTradePlanDetail>(`/mt5/ai-trade/${encodeURIComponent(selectedSymbol.value)}`, { method: 'POST' });
  } catch (error: any) {
    if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED' || error?.status === 503) {
      providerConfigured.value = false;
    } else if (error?.code === 'AI_PLAN_VALIDATION_FAILED') {
      // The AI produced a malformed/contradictory pending-order plan (e.g. a
      // BUY_LIMIT entry above the current market price) — never disguise
      // this as NO_EXECUTION; show it as its own explicit, distinct failure.
      invalidPlanMessage.value = error instanceof Error ? error.message : 'The AI trade plan failed validation.';
    } else {
      errorText.value = error instanceof Error ? error.message : 'AI analysis failed';
    }
  } finally {
    busy.value = false;
  }
}

const SCAN_PROGRESS_MESSAGES = [
  'Discovering MT5 markets...',
  'Validating market data...',
  'Shortlisting candidates...',
  'AI analyzing candidates...',
  'Running Risk Engine...',
  'Ranking opportunities...',
];

async function findBestTrades() {
  scanning.value = true;
  errorText.value = '';
  scanSummary.value = null;
  scanCapacity.value = null;
  scanResults.value = [];
  scanOtherIdeas.value = [];
  scanDiagnostics.value = [];
  scanAiErrors.value = [];
  let step = 0;
  scanProgressMessage.value = SCAN_PROGRESS_MESSAGES[0];
  const progressTimer = setInterval(() => {
    step = Math.min(step + 1, SCAN_PROGRESS_MESSAGES.length - 1);
    scanProgressMessage.value = SCAN_PROGRESS_MESSAGES[step];
  }, 1500);
  try {
    const result = await apiFetch<ScanResponse>('/mt5/ai-trade/scan', { method: 'POST' });
    scanSummary.value = result.summary;
    scanCapacity.value = result.capacity;
    // TOP N only (spec sections 10/11/13/14/16): already ranked by AI
    // Profitability and Risk-PASS-preferred server-side — never re-sorted
    // or re-filtered here, and never padded past what the scan actually
    // found.
    scanResults.value = result.topOpportunities;
    scanOtherIdeas.value = result.otherIdeas;
    scanDiagnostics.value = result.rejected;
    scanAiErrors.value = result.aiErrors;
  } catch (error: any) {
    if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED' || error?.status === 503) {
      providerConfigured.value = false;
    } else {
      errorText.value = error instanceof Error ? error.message : 'Scan failed';
    }
  } finally {
    clearInterval(progressTimer);
    scanning.value = false;
  }
}

const SCAN_ACTION_LABELS: Record<string, string> = { ENTER_NOW: 'ENTER NOW', WAIT_FOR_ENTRY: 'WAIT FOR ENTRY' };
function scanActionLabel(action: string) {
  return SCAN_ACTION_LABELS[action] ?? action;
}
function scanOrderTypeLabel(row: ScanRow) {
  if (!row.pendingOrderType || row.pendingOrderType === 'NONE') return `MARKET ${row.decision}`;
  return row.pendingOrderType.replaceAll('_', ' ');
}
function profitabilityClass(score: number) {
  if (score >= 85) return 'text-emerald-300';
  if (score >= 70) return 'text-sky-300';
  if (score >= 50) return 'text-amber-300';
  return 'text-rose-300';
}

// Re-analyzes the clicked symbol fresh (spec: recalculate against the
// latest tick, never trust a stale scan-time snapshot before showing the
// owner a plan they might act on) — an explicit, owner-initiated single
// follow-up call, not part of the bounded scan budget itself. Reuses the
// exact same single-symbol AI Trade view/Risk Engine/DemoExecutionGateway/
// manual-confirmation flow as ANALYZE WITH AI (spec section 19) — never a
// second, incompatible execution path.
async function selectFromScan(symbol: string) {
  selectedSymbol.value = symbol;
  await analyze();
}

// "PLACE ... IN MT5 DEMO" from a TOP N card: loads the real, freshly
// re-analyzed plan via the exact same path as VIEW PLAN, then opens the
// SAME manual-confirmation modal used everywhere else in this page (spec
// section 14/19) — this never places an order itself and never bypasses
// the owner's explicit confirmation click in that modal.
async function placeFromScan(symbol: string) {
  await selectFromScan(symbol);
  if (plan.value && canPlaceOrder.value) {
    showConfirm.value = true;
  }
}

async function confirmPlace() {
  if (!plan.value?.planId) return;
  approving.value = true;
  confirmationTimedOut.value = false;
  const planId = plan.value.planId;
  try {
    approveOutcome.value = await apiFetch(`/mt5/ai-trade/plans/${planId}/approve`, { method: 'POST' });
    if (approveOutcome.value?.code === 'PENDING_CONFIRMATION') {
      pollPlanStatus(planId, Date.now() + POLL_TIMEOUT_MS);
    }
  } catch (error: any) {
    approveOutcome.value = { allowed: false, code: 'REQUEST_FAILED', reason: error instanceof Error ? error.message : 'The request failed.' };
  } finally {
    approving.value = false;
  }
}

function closeConfirm() {
  stopPolling();
  showConfirm.value = false;
  approveOutcome.value = null;
}

function labelAsset(value: string) {
  return value.replace('_CFD', '').replace('_', ' ');
}

function priceText(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function numberText(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '-';
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$-';
  return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function formatDate(value: unknown) {
  if (!value) return '-';
  return new Date(String(value)).toLocaleString();
}
</script>
