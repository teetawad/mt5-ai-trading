<template>
  <div class="space-y-6">
    <header>
      <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">AI Analysis</p>
      <h1 class="page-title">Choose what you want to trade</h1>
      <p class="page-subtitle">Pick a market and a symbol, and AI will build a complete demo trading plan.</p>
    </header>

    <div
      v-if="errorCode === 'SESSION_EXPIRED'"
      class="rounded-lg border border-amber-400/50 bg-amber-400/10 p-4"
    >
      <p class="text-sm font-bold text-amber-100">Could not complete your request.</p>
      <p class="mt-1 text-sm text-amber-100">Reason: {{ errorText }}</p>
      <button
        class="btn-primary mt-3"
        @click="goToLogin"
      >
        Sign In Again
      </button>
    </div>
    <div
      v-else-if="errorText"
      class="notice-error"
    >
      {{ errorText }}
    </div>
    <div
      v-if="message"
      class="notice-info"
    >
      {{ message }}
    </div>

    <!-- STEP 1 + 2: choose market, then symbol -->
    <div
      ref="symbolPickerRef"
      tabindex="-1"
      class="focus:outline-none"
    >
      <UiCard
        title="1. Choose Market"
        subtitle="Only asset classes that exist in synced MT5 demo instruments are shown."
      >
        <div class="flex flex-wrap gap-2">
          <button
            v-for="asset in availableAssets"
            :key="asset"
            type="button"
            class="rounded-lg border px-4 py-2 text-sm font-semibold transition"
            :class="assetFilter === asset ? 'border-sky-400/60 bg-sky-400/15 text-sky-100' : 'border-slate-700 bg-slate-950/80 text-slate-300 hover:border-sky-400/70'"
            @click="assetFilter = asset"
          >
            {{ asset === 'ALL' ? 'All' : labelAsset(asset) }}
          </button>
        </div>
      </UiCard>

      <UiCard
        title="2. Choose Symbol"
        subtitle="Search or pick from the dropdown."
        class="mt-4"
      >
        <div class="grid gap-3 md:grid-cols-[1fr_18rem]">
          <input
            v-model="search"
            class="field-input"
            placeholder="Search symbol or description (e.g. ETHUSD)"
          >
          <select
            v-model="selectedSymbol"
            class="field-input"
          >
            <option value="">Select symbol</option>
            <option
              v-for="instrument in filteredInstruments"
              :key="instrument.symbol"
              :value="instrument.symbol"
            >
              {{ instrument.symbol }} - {{ labelAsset(instrument.asset_class) }}
            </option>
          </select>
        </div>

        <!-- STEP 3: immediate quick status, shown as soon as a symbol is picked -->
        <div
          v-if="plan && !hasAnalyzed"
          ref="analysisSectionRef"
          tabindex="-1"
          class="mt-5 rounded-lg border p-5 focus:outline-none"
          :class="isClosed ? 'border-amber-400/40 bg-amber-400/10' : 'border-slate-800 bg-slate-950/70'"
        >
          <h3 class="text-2xl font-bold text-white">{{ plan.symbol }}</h3>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
            <span :class="isClosed ? 'text-rose-300' : 'text-emerald-300'">
              {{ isClosed ? '🔴 MARKET CLOSED' : '🟢 Market Open' }}
            </span>
            <span :class="plan.market.dataStatus === 'LIVE' ? 'text-emerald-300' : 'text-amber-300'">
              {{ plan.market.dataStatus === 'LIVE' ? '🟢 Live Data' : `🟠 ${plan.market.dataStatus ?? 'DATA UNKNOWN'}` }}
            </span>
          </div>
          <p
            v-if="isClosed"
            class="mt-3 text-sm leading-6 text-amber-50/90"
          >
            Trading is unavailable now. You can still analyze this symbol to see why.
          </p>
          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <InfoTile
              label="Current Price"
              :value="priceText(plan.quote.currentPrice)"
            />
            <InfoTile
              label="Bid / Ask"
              :value="`${priceText(plan.quote.bid)} / ${priceText(plan.quote.ask)}`"
            />
            <InfoTile
              label="Spread"
              :value="valueText(plan.quote.spread)"
            />
          </div>
          <div class="mt-5 flex flex-wrap items-center gap-3">
            <button
              class="btn-success min-w-52 px-6 py-3 text-base"
              :disabled="busy"
              @click="loadSelected(true)"
            >
              {{ busy ? 'Analyzing...' : `Analyze ${plan.symbol}` }}
            </button>
          </div>
        </div>
        <div
          v-else-if="busy && !plan"
          class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-300"
        >
          Loading {{ selectedSymbol }}...
        </div>
      </UiCard>
    </div>

    <!-- STEP 4/5/6: full AI result, only after the user explicitly analyzes -->
    <template v-if="plan && hasAnalyzed">
      <section
        v-if="!collapsed"
        ref="resultSectionRef"
        tabindex="-1"
        class="rounded-lg border p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)] focus:outline-none"
        :class="planBorder"
      >
        <div class="sticky top-14 z-20 -mx-5 -mt-5 mb-5 rounded-t-lg border-b border-slate-800/80 bg-slate-900/95 px-5 py-5 backdrop-blur">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p class="text-xs font-bold uppercase tracking-widest text-slate-500">{{ labelAsset(plan.assetClass) }}</p>
              <h2 class="mt-1 text-3xl font-semibold text-white">{{ plan.symbol }}</h2>
              <p class="mt-2 text-xs font-bold uppercase tracking-widest text-slate-500">AI Recommendation</p>
              <p
                class="text-5xl font-black tracking-tight"
                :class="recommendationTone"
              >
                {{ plan.decision.action }}
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <StatusPill :label="marketStatusLabel" />
                <StatusPill :label="plan.market.dataStatus" />
                <StatusPill :label="riskStatus" />
                <StatusPill :label="`AUTO-DEMO ${plan.autoDemoEnabled ? 'ON' : 'OFF'}`" />
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap items-start justify-between gap-4 lg:flex-col lg:items-end">
              <div class="flex shrink-0 gap-2">
                <button
                  type="button"
                  class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                  aria-controls="analysis-panel-body"
                  :aria-expanded="true"
                  @click="toggleCollapsed"
                >
                  Collapse
                </button>
                <button
                  type="button"
                  class="btn-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                  aria-label="Close Analysis"
                  @click="closeAnalysis"
                >
                  &#10005; Close
                </button>
              </div>
              <div class="text-left lg:text-right">
                <p class="text-xs text-slate-500">Confidence / Score</p>
                <p class="mt-1 text-2xl font-semibold text-white">
                  {{ confidenceText(plan.decision.confidence) }} · Score {{ round(plan.decision.opportunityScore) }}/100
                </p>
                <p class="mt-2 text-xs text-slate-400">Plan expires {{ dateText(plan.entryPlan.valid_until) }}</p>
              </div>
            </div>
          </div>
        </div>

        <div id="analysis-panel-body">
          <div
            v-if="isClosed"
            class="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/10 p-5"
          >
            <h3 class="text-xl font-semibold text-amber-100">MARKET CLOSED</h3>
            <p class="mt-2 text-sm font-semibold text-amber-100">CANNOT TRADE NOW</p>
            <p class="mt-3 text-sm leading-6 text-amber-50/90">
              This market is currently closed. No new demo trade can be entered.
            </p>
          </div>

          <div
            v-else-if="plan.decision.action === 'WAIT'"
            class="mt-5 rounded-lg border border-slate-700 bg-slate-950/70 p-5"
          >
            <h3 class="text-xl font-semibold text-white">AI: WAIT</h3>
            <p class="mt-2 text-sm font-semibold text-amber-200">DO NOT ENTER NOW</p>
            <p class="mt-3 text-sm leading-6 text-slate-300">{{ plan.explanation.beginnerSummary }}</p>
          </div>

          <section class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-5">
            <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">When to Enter</h3>
            <p
              class="mt-2 text-2xl font-semibold"
              :class="entryTone"
            >
              {{ plan.entryPlan.beginner_label }}
            </p>
            <p class="mt-2 text-sm leading-6 text-slate-300">{{ entryExplanation }}</p>
            <p
              v-if="watcherMessage"
              class="mt-3 rounded-lg border border-sky-400/30 bg-sky-400/10 p-3 text-sm leading-6 text-sky-100"
            >
              {{ watcherMessage }}
            </p>
            <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <InfoTile
                label="Current"
                :value="priceText(plan.entryPlan.current_price ?? plan.quote.currentPrice)"
              />
              <InfoTile
                label="AI Entry Zone"
                :value="entryZoneText"
              />
              <InfoTile
                label="Entry / Reference"
                :value="priceText(plan.entryPlan.reference_entry)"
              />
              <InfoTile
                label="Trigger Price"
                :value="priceText(plan.entryPlan.trigger_price)"
              />
            </div>

            <div
              v-if="progressAxis"
              class="mt-6 rounded-lg border border-slate-800 bg-slate-900/60 p-4"
            >
              <p class="text-xs font-bold uppercase tracking-widest text-slate-500">Live Entry Progress</p>
              <div class="relative mt-8 mb-8 h-2 rounded-full bg-slate-800">
                <div
                  v-if="progressAxis.zoneLow !== null && progressAxis.zoneHigh !== null"
                  class="absolute inset-y-0 rounded-full bg-sky-500/40"
                  :style="{ left: `${Math.min(progressAxis.zoneLow, progressAxis.zoneHigh)}%`, width: `${Math.max(1, Math.abs(progressAxis.zoneHigh - progressAxis.zoneLow))}%` }"
                />
                <div
                  class="absolute inset-y-0 left-0 right-0 rounded-full bg-gradient-to-r from-rose-500/50 via-slate-700/40 to-emerald-500/50"
                  style="z-index:-1"
                />

                <template
                  v-for="marker in progressMarkers"
                  :key="marker.key"
                >
                  <div
                    class="absolute top-1/2 h-3 w-0.5 -translate-y-1/2"
                    :class="marker.lineClass"
                    :style="{ left: `${marker.pct}%` }"
                  />
                  <div
                    class="absolute -top-7 -translate-x-1/2 whitespace-nowrap text-center text-[10px] font-semibold"
                    :class="marker.textClass"
                    :style="{ left: `${marker.pct}%` }"
                  >
                    {{ marker.label }}<br>{{ priceText(marker.value) }}
                  </div>
                  <div
                    v-if="marker.key === 'current' && plan.entryPlan.current_entry_status === 'WAITING'"
                    class="absolute -bottom-7 -translate-x-1/2 whitespace-nowrap text-center text-[10px] font-bold text-sky-300"
                    :style="{ left: `${marker.pct}%` }"
                  >
                    AI IS WAITING HERE &uarr;
                  </div>
                </template>
              </div>
            </div>
          </section>

          <section class="mt-5 grid gap-4 lg:grid-cols-3">
            <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
              <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">How Much</h3>
              <div class="mt-4 space-y-3">
                <InfoTile
                  label="Recommended"
                  :value="lotText"
                />
                <InfoTile
                  label="Approx Amount Exposed"
                  :value="money(plan.positionSizing.approximateNotional)"
                />
                <InfoTile
                  label="Risk Per Account"
                  :value="plan.positionSizing.riskPerAccountPct ? `${plan.positionSizing.riskPerAccountPct}%` : '-'"
                />
              </div>
            </div>
            <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
              <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">Protection</h3>
              <div class="mt-4 space-y-3">
                <InfoTile
                  label="Stop Loss"
                  :value="priceText(plan.protection.stopLoss)"
                  tone="loss"
                />
                <InfoTile
                  label="Take Profit"
                  :value="priceText(plan.protection.takeProfit)"
                  tone="gain"
                />
                <InfoTile
                  label="Risk / Reward"
                  :value="riskRewardText"
                />
              </div>
            </div>
            <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
              <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">AI Expects</h3>
              <div class="mt-4 space-y-3">
                <InfoTile
                  label="Maximum Planned Loss"
                  :value="money(plan.positionSizing.maximumPlannedLoss)"
                  tone="loss"
                />
                <InfoTile
                  label="Target Profit"
                  :value="money(plan.positionSizing.targetProfit)"
                  tone="gain"
                />
                <InfoTile
                  label="Holding Time"
                  :value="holdingText"
                />
              </div>
            </div>
          </section>

          <section class="mt-5 grid gap-4 lg:grid-cols-[1fr_0.85fr]">
            <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
              <h3 class="text-sm font-bold uppercase tracking-widest text-slate-400">Why AI Says This</h3>
              <p class="mt-3 text-sm leading-6 text-slate-300">{{ plan.explanation.beginnerSummary }}</p>
              <ul class="mt-4 space-y-2 text-sm text-slate-300">
                <li
                  v-for="item in plan.explanation.bullets"
                  :key="item"
                >
                  - {{ item }}
                </li>
              </ul>
            </div>
            <div
              class="rounded-lg border p-5"
              :class="plan.risk.result === 'PASS' ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-rose-400/40 bg-rose-400/10'"
            >
              <h3
                class="text-sm font-bold uppercase tracking-widest"
                :class="plan.risk.result === 'PASS' ? 'text-emerald-200' : 'text-rose-200'"
              >
                Risk Engine
              </h3>
              <p class="mt-3 text-2xl font-semibold text-white">{{ plan.risk.label }}</p>
              <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-slate-300">
                <dt class="text-slate-500">Trade count today</dt>
                <dd class="text-right font-mono text-slate-100">{{ dailyTradesText }}</dd>
                <dt class="text-slate-500">Risk per trade</dt>
                <dd class="text-right font-mono text-slate-100">{{ riskPctText }} = {{ money(plan.positionSizing.maximumPlannedLoss) }}</dd>
                <dt class="text-slate-500">Recommended lot</dt>
                <dd class="text-right font-mono text-slate-100">{{ lotText }}</dd>
                <dt class="text-slate-500">Expected loss at SL</dt>
                <dd class="text-right font-mono text-slate-100">{{ money(plan.positionSizing.expectedLossAtSl) }}</dd>
                <dt class="text-slate-500">Required margin</dt>
                <dd class="text-right font-mono text-slate-100">{{ money(plan.positionSizing.marginRequired) }}</dd>
                <dt class="text-slate-500">Free margin</dt>
                <dd class="text-right font-mono text-slate-100">{{ money(plan.positionSizing.freeMargin) }}</dd>
              </dl>
              <div
                v-if="blockedReasons.length"
                class="mt-4 space-y-2 border-t border-white/10 pt-4"
              >
                <p
                  v-for="reason in blockedReasons"
                  :key="reason.rule"
                  class="text-sm leading-6 text-slate-100"
                >
                  <strong>{{ reason.rule }}:</strong> {{ reason.explanation }}
                </p>
              </div>
              <p
                v-else
                class="mt-4 text-sm leading-6 text-emerald-100"
              >
                Risk Engine accepts the planned demo loss and position size. The server will check again before sending an order.
              </p>
            </div>
          </section>

          <details class="mt-5 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
            <summary class="cursor-pointer text-sm font-semibold text-slate-200">Advanced Details</summary>
            <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <InfoTile
                label="Entry Type"
                :value="plan.entryPlan.entry_strategy"
              />
              <InfoTile
                label="Entry Status"
                :value="plan.entryPlan.status_label"
                help="STATUS: WAITING FOR PRICE means AI is monitoring live price in the background."
              />
              <InfoTile
                label="Created At"
                :value="dateText(plan.generatedAt)"
              />
              <InfoTile
                label="Expires At"
                :value="dateText(plan.entryPlan.valid_until)"
              />
              <InfoTile
                label="Last Quote Time"
                :value="dateText(plan.quote.quoteTimestamp)"
              />
              <InfoTile
                label="Data Freshness"
                :value="plan.quote.quoteAgeSeconds === null ? '-' : `${plan.quote.quoteAgeSeconds}s old`"
              />
              <InfoTile
                label="Next Open"
                :value="plan.market.nextOpenThailand ?? '-'"
              />
              <InfoTile
                label="Next Close"
                :value="plan.market.nextCloseThailand ?? '-'"
              />
              <InfoTile
                label="Thailand Time"
                :value="plan.market.thailandTime ?? '-'"
              />
              <InfoTile
                label="Broker / Server Time"
                :value="dateText(plan.market.serverTime)"
              />
              <InfoTile
                label="Session Source"
                :value="plan.market.source"
              />
              <InfoTile
                label="Model"
                :value="plan.decision.modelVersion ?? '-'"
              />
            </div>
            <p class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Raw AI feature vector</p>
            <pre class="mt-2 max-h-96 overflow-auto text-xs leading-5 text-slate-400">{{ JSON.stringify(plan.decision.features ?? {}, null, 2) }}</pre>
          </details>

          <div class="mt-5 flex flex-col gap-3 border-t border-slate-800 pt-5 md:flex-row md:items-center md:justify-between">
            <p class="text-sm text-slate-300">{{ tradeButtonHelp }}</p>
            <button
              class="min-w-52 px-6 py-3 text-base"
              :class="tradeButtonState === 'FAILED' ? 'btn-danger' : 'btn-success'"
              :disabled="tradeButtonDisabled"
              @click="openTradeModal"
            >
              {{ tradeButtonLabel }}
            </button>
          </div>

          <div
            v-if="activeTrade"
            class="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-4"
          >
            <p class="text-xs font-bold uppercase tracking-widest text-emerald-200">Active Demo Trade</p>
            <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-lg font-semibold text-white">{{ activeTrade.symbol }} {{ activeTrade.side }}</p>
                <p class="text-xs text-slate-400">MT5 Ticket {{ activeTrade.ticket }}</p>
              </div>
              <div class="text-right">
                <p class="text-xs text-slate-500">Current P&L</p>
                <p
                  class="text-xl font-semibold"
                  :class="activeTrade.pnl === null ? 'text-slate-300' : activeTrade.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'"
                >
                  {{ activeTrade.pnl === null ? '-' : money(activeTrade.pnl) }}
                </p>
              </div>
              <NuxtLink
                :to="`/positions?ticket=${encodeURIComponent(activeTrade.ticket)}`"
                class="btn-primary"
              >
                View Open Trade
              </NuxtLink>
            </div>
          </div>
        </div>
      </section>

      <section
        v-else
        ref="resultSectionRef"
        tabindex="-1"
        class="rounded-lg border p-5 shadow-[0_18px_60px_rgba(2,6,23,0.28)] focus:outline-none"
        :class="planBorder"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-xs font-bold uppercase tracking-widest text-slate-500">{{ labelAsset(plan.assetClass) }}</p>
            <h2 class="mt-1 text-2xl font-semibold text-white">{{ plan.symbol }}</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <StatusPill :label="`AI ${plan.decision.action}`" />
              <StatusPill :label="plan.entryPlan.beginner_label" />
              <StatusPill :label="marketStatusLabel" />
            </div>
            <p class="mt-3 text-sm text-slate-300">{{ confidenceText(plan.decision.confidence) }}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              aria-controls="analysis-panel-body"
              :aria-expanded="false"
              @click="toggleCollapsed"
            >
              Expand
            </button>
            <button
              type="button"
              class="btn-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              aria-label="Close Analysis"
              @click="closeAnalysis"
            >
              &#10005; Close
            </button>
          </div>
        </div>
      </section>
    </template>

    <UiCard
      v-else-if="!plan"
      title="Choose something to analyze"
    >
      <ol class="list-inside list-decimal space-y-1 text-sm leading-6 text-slate-300">
        <li>Select a market</li>
        <li>Select a symbol</li>
        <li>Click Analyze</li>
      </ol>
      <p class="mt-4 text-sm leading-6 text-slate-300">AI will then show:</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm leading-6 text-slate-300">
        <li>BUY / SELL / WAIT</li>
        <li>entry timing</li>
        <li>lot size</li>
        <li>Stop Loss</li>
        <li>Take Profit</li>
        <li>maximum loss</li>
        <li>target profit</li>
      </ul>
    </UiCard>

    <!-- Secondary: watchlist management, below the main analysis workflow -->
    <UiCard
      title="AI Watchlist"
      subtitle="Symbols checked here are scanned together when you press Scan Watchlist. Changes save immediately."
    >
      <input
        v-model="watchlistSearch"
        class="field-input"
        placeholder="Search instruments..."
      >
      <div class="mt-3 grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/60 p-2 sm:grid-cols-2 lg:grid-cols-3">
        <label
          v-for="instrument in watchlistFilteredInstruments"
          :key="instrument.symbol"
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 transition hover:bg-slate-800/70"
        >
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-400"
            :checked="instrument.watchlist_enabled"
            :disabled="busy"
            @change="toggleWatch(instrument)"
          >
          <span class="font-semibold">{{ instrument.symbol }}</span>
          <span class="text-xs text-slate-500">{{ labelAsset(instrument.asset_class) }}</span>
        </label>
        <p
          v-if="!watchlistFilteredInstruments.length"
          class="col-span-full py-4 text-center text-sm text-slate-500"
        >
          No instruments match your search.
        </p>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="btn-primary"
          :disabled="busy"
          @click="runScan"
        >
          {{ busy ? 'Scanning...' : 'Scan Watchlist' }}
        </button>
      </div>

      <div
        v-if="rankedRows.length"
        class="mt-5 grid gap-3"
      >
        <p class="text-xs font-bold uppercase tracking-widest text-slate-500">Watchlist Results</p>
        <button
          v-for="(row, index) in rankedRows"
          :key="row.symbol"
          class="rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-sky-400/60"
          @click="selectFromRanked(row.symbol)"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="font-semibold text-white">#{{ index + 1 }} {{ row.symbol }}</span>
            <StatusPill :label="row.decision === 'BUY' || row.decision === 'SELL' ? row.decision : 'WAIT'" />
          </div>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{{ confidenceText(row.confidence) }}</span>
            <span>Score {{ round(row.opportunity_score) }}/100</span>
            <span>Market {{ row.market_status ?? 'UNKNOWN' }}</span>
          </div>
        </button>
      </div>
      <EmptyState
        v-else
        title="No scan results yet"
        message="Check the symbols you want above, then press Scan Watchlist for ranked opportunities."
      />
    </UiCard>

    <TradeInDemoModal
      v-if="confirmRow"
      :plan="confirmRow"
      :state="tradeState"
      :outcome="tradeOutcome"
      @cancel="cancelTradeModal"
      @confirm="confirmTrade"
      @close="closeTradeModal"
      @view-open-trade="viewOpenTrade"
      @analyze-again="analyzeAgain"
    />

    <div
      v-if="toastMessage"
      class="fixed bottom-6 right-6 z-[60] rounded-lg border border-emerald-400/50 bg-emerald-500/95 px-5 py-3 text-sm font-semibold text-white shadow-2xl"
      role="status"
    >
      {{ toastMessage }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ApiError } from '../composables/useApi';

type InstrumentRow = { symbol: string; asset_class: string; description?: string | null; watchlist_enabled: boolean };
type DisabledReason = { rule: string; explanation: string };
type AnalysisPlan = {
  generatedAt: string;
  timezone: string;
  symbol: string;
  assetClass: string;
  autoDemoEnabled: boolean;
  watcher?: { started: boolean; intervalMs: number; lastTickAt: string | null };
  status?: Record<string, any>;
  market: Record<string, any>;
  quote: Record<string, any>;
  decision: Record<string, any>;
  entryPlan: Record<string, any>;
  protection: Record<string, any>;
  positionSizing: Record<string, any>;
  risk: { result: string; label: string; diagnostics: DisabledReason[] };
  explanation: { beginnerSummary: string; bullets: string[] };
  tradeButton: { enabled: boolean; label: string; disabledReasons: DisabledReason[] };
  // Single source of truth for whether "Trade in Demo" can actually be
  // clicked — grounded in the real persisted plan row (status +
  // execution_key), not independently re-derived from AI BUY/RISK PASS/
  // MARKET OPEN on the frontend.
  execution?: {
    canExecute: boolean;
    entryStatus: 'WAITING' | 'READY' | 'TRIGGERED' | 'EXECUTING' | 'EXECUTED' | 'BLOCKED' | 'EXPIRED' | 'CANCELLED' | null;
    blockCode: string | null;
    blockMessage: string | null;
  };
};
type ScannerRow = { symbol: string; decision?: string; market_status?: string; opportunity_score?: number; confidence?: number };

const { apiFetch } = useApi();
const { logout } = useAuth();
const busy = ref(false);
const message = ref('');
const errorText = ref('');
const errorCode = ref<string | null>(null);
const search = ref('');
const watchlistSearch = ref('');
const assetFilter = ref('ALL');
const selectedSymbol = ref('');
const plan = ref<AnalysisPlan | null>(null);
const hasAnalyzed = ref(false);
const confirmRow = ref<AnalysisPlan | null>(null);
const collapsed = ref(false);
const resultSectionRef = ref<HTMLElement | null>(null);
const analysisSectionRef = ref<HTMLElement | null>(null);
const symbolPickerRef = ref<HTMLElement | null>(null);
const toastMessage = ref('');
const activeTrade = ref<{ symbol: string; side: string; ticket: string; pnl: number | null } | null>(null);

const { state: tradeState, outcome: tradeOutcome, execute: executeTrade, reset: resetTrade } = useTradeExecution(apiFetch);

const { data: instrumentsData, refresh: refreshInstruments } = await useAsyncData<{ instruments: InstrumentRow[] }>('analysis-instruments-v2', () => apiFetch('/mt5/instruments'), { lazy: true });
const { data: scanner, refresh: refreshScanner } = await useAsyncData<Record<string, any>>('analysis-scanner-v2', () => apiFetch('/mt5/scanner'), { lazy: true });
useAutoRefresh(refreshLightweight, 10000);

const instruments = computed(() => instrumentsData.value?.instruments ?? []);
const availableAssets = computed(() => ['ALL', ...new Set(instruments.value.map((instrument) => instrument.asset_class).filter(Boolean))]);
const filteredInstruments = computed(() => {
  const term = search.value.trim().toLowerCase();
  return instruments.value.filter((instrument) => {
    const matchesAsset = assetFilter.value === 'ALL' || instrument.asset_class === assetFilter.value;
    const matchesSearch = !term || instrument.symbol.toLowerCase().includes(term) || (instrument.description ?? '').toLowerCase().includes(term);
    return matchesAsset && matchesSearch;
  });
});
const watchlistFilteredInstruments = computed(() => {
  const term = watchlistSearch.value.trim().toLowerCase();
  if (!term) return instruments.value;
  return instruments.value.filter((instrument) => instrument.symbol.toLowerCase().includes(term) || (instrument.description ?? '').toLowerCase().includes(term));
});
const rankedRows = computed<ScannerRow[]>(() => [...(scanner.value?.scanner ?? [])].sort((a, b) => Number(b.opportunity_score ?? 0) - Number(a.opportunity_score ?? 0)));
const isClosed = computed(() => plan.value?.market.status === 'CLOSED');
const marketStatusLabel = computed(() => isClosed.value ? 'MARKET CLOSED' : `MARKET ${plan.value?.market.status ?? 'UNKNOWN'}`);
const riskStatus = computed(() => plan.value?.risk.result === 'PASS' ? 'RISK PASS' : 'TRADE BLOCKED');
const blockedReasons = computed(() => plan.value?.tradeButton.disabledReasons?.length ? plan.value.tradeButton.disabledReasons : plan.value?.risk.diagnostics ?? []);
const planBorder = computed(() => {
  if (plan.value?.tradeButton.enabled) return 'border-emerald-400/40 bg-slate-900/80';
  if (isClosed.value) return 'border-amber-400/40 bg-slate-900/80';
  return 'border-slate-800 bg-slate-900/80';
});
const recommendationTone = computed(() => {
  const action = plan.value?.decision.action;
  if (action === 'BUY') return 'text-emerald-300';
  if (action === 'SELL') return 'text-rose-300';
  return 'text-amber-300';
});
const entryTone = computed(() => {
  const label = plan.value?.entryPlan.beginner_label;
  if (label === 'ENTER NOW') return 'text-emerald-200';
  if (label === 'DO NOT ENTER') return 'text-amber-200';
  return 'text-sky-200';
});
const entryZoneText = computed(() => {
  if (!plan.value) return '-';
  const low = plan.value.entryPlan.entry_zone_low;
  const high = plan.value.entryPlan.entry_zone_high;
  return low && high ? `${priceText(low)} - ${priceText(high)}` : '-';
});
const entryExplanation = computed(() => {
  if (!plan.value) return '';
  const strategy = plan.value.entryPlan.entry_strategy;
  if (strategy === 'MARKET_NOW') return `AI considers the current price acceptable. Enter around ${priceText(plan.value.entryPlan.reference_entry)} if all safety checks still pass.`;
  if (strategy === 'PULLBACK') return `AI recommends waiting for price to move into ${entryZoneText.value} before entering.`;
  if (strategy === 'BREAKOUT') return `Wait until price breaks ${priceText(plan.value.entryPlan.trigger_price)} before entering.`;
  return 'Conditions are not suitable yet. No demo trade should be entered.';
});
const lotText = computed(() => {
  const value = plan.value?.positionSizing.recommendedLotSize ?? confirmRow.value?.positionSizing.recommendedLotSize;
  return Number.isFinite(Number(value)) && Number(value) > 0 ? `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} lot` : '-';
});
const riskRewardText = computed(() => {
  const rr = plan.value?.protection.riskReward;
  return rr ? `1 : ${Number(rr).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-';
});
const dailyTradesText = computed(() => {
  const used = plan.value?.positionSizing.dailyConfirmedTrades;
  const limit = plan.value?.positionSizing.dailyTradeLimit;
  if (!Number.isFinite(Number(used)) || !Number.isFinite(Number(limit))) return '-';
  return `${used}/${limit} today`;
});
const riskPctText = computed(() => {
  const pct = plan.value?.positionSizing.riskPerAccountPct;
  return Number.isFinite(Number(pct)) ? `${Number(pct).toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : '-';
});
const holdingText = computed(() => {
  const hours = Number(plan.value?.decision.expectedHoldingHours);
  if (!Number.isFinite(hours) || hours <= 0) return '-';
  return hours <= 4 ? '1-4 hours' : `${hours} hours`;
});
const watcherMessage = computed(() => {
  if (!plan.value) return '';
  const strategy = plan.value.entryPlan.entry_strategy;
  const status = plan.value.entryPlan.current_entry_status;
  if ((strategy === 'PULLBACK' || strategy === 'BREAKOUT') && (status === 'WAITING' || status === 'TRIGGERED')) {
    return `AI is monitoring ${plan.value.symbol}. If price reaches the planned entry zone before expiry, the system will check risk again and may enter the DEMO trade automatically.`;
  }
  if (status === 'BLOCKED') return plan.value.entryPlan.status_message ?? 'Entry condition was reached but the trade was blocked.';
  if (status === 'EXPIRED') return 'PLAN EXPIRED. No trade was entered.';
  return '';
});

type ProgressMarker = { key: string; label: string; value: unknown; pct: number; lineClass: string; textClass: string };

const progressAxis = computed(() => {
  if (!plan.value) return null;
  const strategy = plan.value.entryPlan.entry_strategy;
  if (strategy === 'MARKET_NOW' || strategy === 'NO_ENTRY') return null;
  const sl = Number(plan.value.entryPlan.stop_loss ?? plan.value.protection.stopLoss);
  const tp = Number(plan.value.entryPlan.take_profit ?? plan.value.protection.takeProfit);
  const current = Number(plan.value.entryPlan.current_price ?? plan.value.quote.currentPrice);
  const zoneLow = Number(plan.value.entryPlan.entry_zone_low);
  const zoneHigh = Number(plan.value.entryPlan.entry_zone_high);
  const trigger = Number(plan.value.entryPlan.trigger_price);
  const points = [sl, tp, current, zoneLow, zoneHigh, trigger].filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pct = (value: number) => Number.isFinite(value) ? ((value - min) / span) * 100 : null;
  return {
    sl: Number.isFinite(sl) ? pct(sl) : null,
    tp: Number.isFinite(tp) ? pct(tp) : null,
    current: Number.isFinite(current) ? pct(current) : null,
    zoneLow: Number.isFinite(zoneLow) ? pct(zoneLow) : null,
    zoneHigh: Number.isFinite(zoneHigh) ? pct(zoneHigh) : null,
    trigger: Number.isFinite(trigger) ? pct(trigger) : null,
    rawSl: sl,
    rawTp: tp,
    rawCurrent: current,
    rawTrigger: trigger,
  };
});

const progressMarkers = computed<ProgressMarker[]>(() => {
  const axis = progressAxis.value;
  if (!axis) return [];
  const markers: ProgressMarker[] = [];
  if (axis.sl !== null) markers.push({ key: 'sl', label: 'SL', value: axis.rawSl, pct: axis.sl, lineClass: 'bg-rose-400', textClass: 'text-rose-300' });
  if (axis.trigger !== null) markers.push({ key: 'trigger', label: 'TRIGGER', value: axis.rawTrigger, pct: axis.trigger, lineClass: 'bg-sky-400', textClass: 'text-sky-300' });
  if (axis.current !== null) markers.push({ key: 'current', label: 'CURRENT', value: axis.rawCurrent, pct: axis.current, lineClass: 'bg-white', textClass: 'text-white' });
  if (axis.tp !== null) markers.push({ key: 'tp', label: 'TP', value: plan.value?.entryPlan.take_profit ?? plan.value?.protection.takeProfit, pct: axis.tp, lineClass: 'bg-emerald-400', textClass: 'text-emerald-300' });
  return markers.sort((a, b) => a.pct - b.pct);
});

const tradeButtonHelp = computed(() => {
  if (!plan.value) return '';
  const execution = plan.value.execution;
  if (execution) {
    if (execution.canExecute) return 'Demo trade is available. Final server-side checks still run before order submission.';
    // "Not ready yet" (AI is waiting for price) reads far better in the
    // AI's own words about entry timing than as a raw rule code.
    if (execution.entryStatus === 'WAITING') return entryExplanation.value;
    if (execution.blockMessage) return execution.blockMessage;
  }
  if (plan.value.tradeButton.enabled) return 'Demo trade is available. Final server-side checks still run before order submission.';
  const first = blockedReasons.value[0];
  if (!first) return 'Demo trade disabled.';
  if (first.rule === plan.value.entryPlan.current_entry_status) return entryExplanation.value;
  return `Demo trade disabled: ${first.rule} - ${first.explanation}`;
});

type TradeButtonState =
  | 'READY' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED'
  | 'WAITING_ENTRY' | 'RISK_BLOCKED' | 'MARKET_CLOSED'
  | 'EXECUTING' | 'ALREADY_EXECUTED' | 'PLAN_EXPIRED' | 'PLAN_BLOCKED' | 'PLAN_CANCELLED';

// Backend `execution` (canExecute/entryStatus/blockCode) is the single
// source of truth once present — this must never independently re-derive
// eligibility from AI BUY/RISK PASS/MARKET OPEN when the backend has
// already told us the real, persisted claim state.
const tradeButtonState = computed<TradeButtonState>(() => {
  if (tradeState.value === 'sending') return 'IN_PROGRESS';
  if (tradeState.value === 'success') return 'SUCCESS';
  if (tradeState.value === 'failed') return 'FAILED';
  if (!plan.value) return 'RISK_BLOCKED';

  const execution = plan.value.execution;
  if (execution) {
    if (execution.canExecute) return 'READY';
    switch (execution.entryStatus) {
      case 'WAITING': return 'WAITING_ENTRY';
      case 'EXECUTING': return 'EXECUTING';
      case 'EXECUTED': return 'ALREADY_EXECUTED';
      case 'EXPIRED': return 'PLAN_EXPIRED';
      case 'CANCELLED': return 'PLAN_CANCELLED';
      case 'BLOCKED': return 'PLAN_BLOCKED';
      default: break;
    }
    if (execution.blockCode?.startsWith('MARKET_')) return 'MARKET_CLOSED';
    return 'RISK_BLOCKED';
  }

  // Fallback only used if the backend response predates the `execution`
  // field entirely (should not happen against this API version).
  if (plan.value.tradeButton.enabled) return 'READY';
  const rules = plan.value.tradeButton.disabledReasons.map((reason: DisabledReason) => reason.rule);
  if (rules.some((rule) => rule.startsWith('MARKET_'))) return 'MARKET_CLOSED';
  if (rules.includes(plan.value.entryPlan.current_entry_status)) return 'WAITING_ENTRY';
  return 'RISK_BLOCKED';
});

const tradeButtonLabel = computed(() => {
  switch (tradeButtonState.value) {
    case 'READY': return 'Trade in MT5 Demo';
    case 'IN_PROGRESS': return 'Opening in MT5...';
    case 'SUCCESS': return 'MT5 Position Opened ✓';
    case 'FAILED': return 'Trade Failed — View Reason';
    case 'WAITING_ENTRY': return 'Waiting for Entry';
    case 'EXECUTING': return 'Opening in MT5...';
    case 'ALREADY_EXECUTED': return 'Already Opened';
    case 'PLAN_EXPIRED': return 'Plan Expired';
    case 'PLAN_CANCELLED': return 'Plan Cancelled';
    case 'PLAN_BLOCKED': return 'Trade Blocked';
    case 'RISK_BLOCKED': return 'Blocked by Risk';
    case 'MARKET_CLOSED': return 'Market Closed';
    default: return 'Trade in MT5 Demo';
  }
});

// SUCCESS/FAILED stay clickable so the owner can reopen the result (view the
// ticket, or the exact failure reason) without re-running analysis first.
// Every other state means execution is genuinely not eligible right now and
// must never be clickable.
const tradeButtonDisabled = computed(() => busy.value || !['READY', 'SUCCESS', 'FAILED'].includes(tradeButtonState.value));

function openTradeModal() {
  if (!plan.value) return;
  if (tradeButtonState.value === 'SUCCESS' || tradeButtonState.value === 'FAILED') {
    // Reopen the existing result rather than starting a fresh confirmation.
    confirmRow.value = plan.value;
    return;
  }
  resetTrade();
  confirmRow.value = plan.value;
}

watch(selectedSymbol, async (symbol) => {
  // Selecting a new symbol always replaces whatever analysis was showing and
  // resets collapse/analyzed state, so a symbol switch never stays stuck on
  // a previous symbol's full result or a stale success/failure trade state.
  collapsed.value = false;
  hasAnalyzed.value = false;
  resetTrade();
  confirmRow.value = null;
  if (!symbol) {
    plan.value = null;
    return;
  }
  await loadSelected(false);
  await nextTick();
  analysisSectionRef.value?.focus({ preventScroll: true });
  analysisSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
}

function closeAnalysis() {
  // Frontend-only: clears which symbol is selected and hides the analysis
  // display. Never calls any backend endpoint, so the saved AI decision,
  // entry plan, watchlist membership, and risk/AUTO-DEMO state are untouched.
  selectedSymbol.value = '';
  collapsed.value = false;
  hasAnalyzed.value = false;
  nextTick(() => {
    symbolPickerRef.value?.focus({ preventScroll: true });
    symbolPickerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (isTypingTarget(event.target)) return;
  if (!plan.value) return;
  closeAnalysis();
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

// Centralizes error display so every action shows a plain-language message
// (and, for an expired session, a distinct "Sign In Again" banner) instead
// of a raw "[PATCH] http://...: 401 Unauthorized" string. Technical detail
// is still logged to the dev console by apiFetch() itself.
function reportError(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    errorCode.value = error.code;
    errorText.value = error.message;
  } else {
    errorCode.value = null;
    errorText.value = error instanceof Error ? error.message : fallback;
  }
}

function goToLogin() {
  void logout();
}

async function loadSelected(persist: boolean) {
  if (!selectedSymbol.value) return;
  // Captured so a response for a symbol the user has since closed or
  // switched away from can never overwrite the current selection/display.
  const requestedSymbol = selectedSymbol.value;
  busy.value = true;
  errorText.value = '';
  errorCode.value = null;
  message.value = '';
  try {
    const result = await apiFetch<AnalysisPlan>(`/mt5/analysis/${encodeURIComponent(requestedSymbol)}`, { method: persist ? 'POST' : 'GET' });
    if (selectedSymbol.value !== requestedSymbol) return;
    plan.value = result;
    if (persist) {
      hasAnalyzed.value = true;
      const planId = result.entryPlan.id ? String(result.entryPlan.id).slice(0, 8) : '-';
      const entryStatus = result.execution?.entryStatus ?? result.entryPlan.status_label ?? '-';
      message.value = `New plan saved for ${requestedSymbol} — Plan ID ${planId} · Entry status ${entryStatus} · Expires ${dateText(result.entryPlan.valid_until)}.`;
    } else {
      message.value = '';
    }
  } catch (error) {
    if (selectedSymbol.value === requestedSymbol) reportError(error, 'Could not load trading plan');
  } finally {
    // Always clear the shared busy flag so switching away from/closing a
    // symbol mid-request never leaves other controls disabled forever.
    busy.value = false;
  }
}

async function refreshLightweight() {
  if (activeTrade.value) await refreshActiveTradePnl();
  if (!selectedSymbol.value || busy.value) return;
  await loadSelected(false);
}

async function toggleWatch(instrument: InstrumentRow) {
  busy.value = true;
  errorText.value = '';
  errorCode.value = null;
  message.value = '';
  try {
    await apiFetch('/mt5/watchlist', { method: 'PATCH', body: { symbols: [instrument.symbol], enabled: !instrument.watchlist_enabled } });
    message.value = `${instrument.watchlist_enabled ? 'Disabled' : 'Enabled'} ${instrument.symbol} for AI scans.`;
    await Promise.all([refreshInstruments(), refreshScanner()]);
  } catch (error) {
    reportError(error, 'Could not update watchlist.');
  } finally {
    busy.value = false;
  }
}

async function runScan() {
  busy.value = true;
  errorText.value = '';
  errorCode.value = null;
  message.value = '';
  try {
    scanner.value = await apiFetch('/mt5/scanner/run', { method: 'POST' });
    message.value = `Scanned ${rankedRows.value.length} enabled symbol${rankedRows.value.length === 1 ? '' : 's'}.`;
  } catch (error) {
    reportError(error, 'Watchlist scan failed');
  } finally {
    busy.value = false;
  }
}

// Clicking a ranked watchlist result should feel like "select this symbol
// and show me its full analysis" in one click, not just a bare selection.
async function selectFromRanked(symbol: string) {
  selectedSymbol.value = symbol;
  await loadSelected(true);
}

async function confirmTrade() {
  if (!confirmRow.value) return;
  const symbol = confirmRow.value.symbol;
  const result = await executeTrade(symbol);
  if (result.success === true && result.mt5Confirmed === true) {
    toast(`MT5 Demo trade opened successfully.`);
    activeTrade.value = {
      symbol: String(result.symbol ?? symbol),
      side: String(result.side ?? confirmRow.value.decision.action ?? ''),
      ticket: String(result.ticket ?? result.orderTicket ?? ''),
      pnl: null,
    };
    await refreshActiveTradePnl();
    // Open Trades must reflect this immediately, not just after the next
    // background poll — pre-warm its cached data now so navigating there
    // (directly, or via "View Open Trade") never shows a stale list.
    await apiFetch('/mt5/positions').catch(() => null);
  }
}

function cancelTradeModal() {
  // Cancel never calls the API — resetTrade() only clears local state.
  resetTrade();
  confirmRow.value = null;
}

function closeTradeModal() {
  confirmRow.value = null;
}

async function viewOpenTrade() {
  const ticket = tradeOutcome.value?.ticket ?? tradeOutcome.value?.orderTicket;
  confirmRow.value = null;
  await navigateTo(ticket ? `/positions?ticket=${encodeURIComponent(String(ticket))}` : '/positions');
}

async function analyzeAgain() {
  resetTrade();
  confirmRow.value = null;
  await loadSelected(true);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string) {
  toastMessage.value = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMessage.value = ''; }, 5000);
}

async function refreshActiveTradePnl() {
  if (!activeTrade.value) return;
  try {
    const result = await apiFetch<{ positions: Array<{ ticket?: string | number; profit?: unknown }> }>('/mt5/positions');
    const match = result.positions.find((position) => String(position.ticket) === activeTrade.value?.ticket);
    if (activeTrade.value) activeTrade.value.pnl = match ? Number(match.profit) : null;
  } catch {
    // Best-effort only — the persistent widget just keeps its last known
    // value rather than surfacing a transient polling error.
  }
}

function priceText(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || value === null || value === undefined || value === '') return '-';
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function valueText(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$-';
  return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// AI confidence is a distinct backend field from opportunity score — never
// derive one from the other. When it's genuinely missing (null/undefined),
// say so instead of rendering a fabricated 0%, which is indistinguishable
// from a real 0% confidence decision (e.g. WAIT/NO_TRADE).
function confidenceText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Confidence unavailable';
  const number = Number(value);
  return Number.isFinite(number) ? `Confidence ${Math.round(number * 100)}%` : 'Confidence unavailable';
}

function round(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function dateText(value: unknown) {
  if (!value) return '-';
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '-';
}

function labelAsset(value: string | undefined) {
  return String(value ?? 'OTHER').replace('_CFD', '').replace('_', ' ');
}
</script>
