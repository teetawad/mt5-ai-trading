import { Pool } from 'pg';
import { MarketAnalysisPackage, TimeframeSnapshot } from './types';
import { ScanResultRow } from './opportunity-scan';

// Shadow Trading (spec sections 6, 13, 14, 16): every technically-valid
// actionable AI setup from an M5 cycle automatically becomes a Shadow
// Trade — WITHOUT ever calling order_send(). This module only ever INSERTs
// into shadow_trades and reads MarketAnalysisPackage/ai_trade_plans rows
// already fetched/persisted elsewhere; it deliberately never imports
// mt5-client.ts's sendMt5Order/sendMt5PendingOrder/checkMt5Order, which is
// what makes "shadow never calls order_send" true by construction rather
// than by convention.

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeframeByName(pkg: MarketAnalysisPackage, name: TimeframeSnapshot['timeframe']): TimeframeSnapshot | null {
  return pkg.timeframes.find((tf) => tf.timeframe === name) ?? null;
}

// Learning dataset feature snapshot (spec section 14). Derived once from the
// already-fetched MarketAnalysisPackage — no extra MT5 calls.
export function buildFeatureSnapshot(pkg: MarketAnalysisPackage, planRow: Record<string, unknown>): Record<string, unknown> {
  const perTimeframe: Record<string, unknown> = {};
  for (const tf of pkg.timeframes) {
    perTimeframe[tf.timeframe] = {
      trend: tf.trend,
      rsi14: tf.rsi14,
      macd: tf.macd,
      macdSignal: tf.macdSignal,
      macdHistogram: tf.macdHistogram,
      atr14: tf.atr14,
      sma20: tf.sma20,
      sma50: tf.sma50,
      ema20: tf.ema20,
      ema50: tf.ema50,
    };
  }

  const m15 = timeframeByName(pkg, 'M15');
  const entryPrice = numberOrNull(planRow.entry_price) ?? numberOrNull(planRow.entry_zone_high) ?? numberOrNull(planRow.trigger_price);
  const stopLoss = numberOrNull(planRow.stop_loss);
  const takeProfit = numberOrNull(planRow.take_profit);
  const nearestLevel = m15 && m15.supportResistance.length && entryPrice !== null
    ? Math.min(...m15.supportResistance.map((level) => Math.abs(level - entryPrice)))
    : null;

  return {
    symbol: pkg.symbol,
    assetClass: pkg.assetClass,
    session: pkg.market.status,
    timeframes: perTimeframe,
    spread: pkg.quote.spread,
    spreadOverAtr: pkg.quote.spread !== null && m15?.atr14 ? pkg.quote.spread / m15.atr14 : null,
    supportResistanceDistance: nearestLevel,
    entryType: planRow.entry_type,
    entryDistance: entryPrice !== null && pkg.quote.bid !== null && pkg.quote.ask !== null
      ? Math.abs(entryPrice - (planRow.decision === 'BUY' ? pkg.quote.ask : pkg.quote.bid))
      : null,
    stopLossDistance: entryPrice !== null && stopLoss !== null ? Math.abs(entryPrice - stopLoss) : null,
    takeProfitDistance: entryPrice !== null && takeProfit !== null ? Math.abs(entryPrice - takeProfit) : null,
    riskReward: numberOrNull(planRow.risk_reward),
  };
}

function orderTypeFor(entryType: string, pendingOrderType: string): 'MARKET' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP' {
  if (entryType === 'MARKET_NOW') return 'MARKET';
  if (pendingOrderType === 'BUY_LIMIT' || pendingOrderType === 'SELL_LIMIT' || pendingOrderType === 'BUY_STOP' || pendingOrderType === 'SELL_STOP') return pendingOrderType;
  // Genuinely shouldn't happen for an actionable, technically-valid plan —
  // decision-policy.ts only allows WAIT_FOR_ENTRY for PULLBACK/BREAKOUT
  // entries, which always carry a concrete pending_order_type.
  throw new Error(`Cannot determine shadow order type for entry_type=${entryType} pending_order_type=${pendingOrderType}`);
}

export interface ShadowTradeCreationResult {
  created: number;
  skipped: number;
}

export async function createShadowTradesForCycle(
  pool: Pool,
  actionableRows: ScanResultRow[],
  packagesBySymbol: Map<string, MarketAnalysisPackage>,
  m5CandleTimestamp: string,
): Promise<ShadowTradeCreationResult> {
  let created = 0;
  let skipped = 0;

  for (const row of actionableRows) {
    if (!row.planId) {
      skipped += 1;
      continue;
    }
    const pkg = packagesBySymbol.get(row.symbol);
    if (!pkg) {
      skipped += 1;
      continue;
    }

    const planResult = await pool.query('SELECT * FROM ai_trade_plans WHERE id = $1', [row.planId]);
    const planRow = planResult.rows[0] as Record<string, unknown> | undefined;
    if (!planRow) {
      skipped += 1;
      continue;
    }

    const direction = String(planRow.decision) as 'BUY' | 'SELL';
    const entryType = String(planRow.entry_type);
    const pendingOrderType = String(planRow.pending_order_type ?? 'NONE');
    let orderType: 'MARKET' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
    try {
      orderType = orderTypeFor(entryType, pendingOrderType);
    } catch {
      skipped += 1;
      continue;
    }

    const stopLoss = numberOrNull(planRow.stop_loss);
    const takeProfit = numberOrNull(planRow.take_profit);
    if (stopLoss === null || takeProfit === null) {
      // Never create a shadow trade without both protective levels — there
      // would be nothing to simulate an outcome against.
      skipped += 1;
      continue;
    }

    const featureSnapshot = buildFeatureSnapshot(pkg, planRow);
    const isEnterNow = row.action === 'ENTER_NOW';
    // Realistic executable side (spec section 7): ask for BUY, bid for SELL.
    const immediateEntry = direction === 'BUY' ? pkg.quote.ask : pkg.quote.bid;

    const result = await pool.query(
      `INSERT INTO shadow_trades(
         ai_trade_plan_id, analysis_run_id, symbol, asset_class, m5_candle_timestamp,
         direction, action, order_type,
         planned_entry, entry_zone_low, entry_zone_high, trigger_price,
         stop_loss, take_profit, risk_reward,
         confidence_pct, tradeability_pct, profitability_score,
         ai_provider, ai_model, ai_prompt_version, feature_snapshot, plan_expiry,
         status, actual_shadow_entry, entered_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (ai_trade_plan_id) DO NOTHING
       RETURNING id`,
      [
        row.planId, planRow.analysis_run_id, row.symbol, row.assetClass, m5CandleTimestamp,
        direction, row.action, orderType,
        numberOrNull(planRow.entry_price), numberOrNull(planRow.entry_zone_low), numberOrNull(planRow.entry_zone_high), numberOrNull(planRow.trigger_price),
        stopLoss, takeProfit, numberOrNull(planRow.risk_reward),
        row.confidencePct, row.tradeabilityPct, row.profitabilityScore,
        row.aiProvider, row.aiModel, row.aiPromptVersion, JSON.stringify(featureSnapshot), planRow.plan_expiry,
        isEnterNow ? 'ENTERED' : 'AWAITING_TRIGGER',
        isEnterNow ? immediateEntry : null,
        isEnterNow ? new Date().toISOString() : null,
      ],
    );

    if (result.rows.length) created += 1;
    else skipped += 1; // ON CONFLICT DO NOTHING: shadow trade for this plan already exists.
  }

  return { created, skipped };
}

export interface ListShadowTradesOptions {
  status?: string;
  symbol?: string;
  limit?: number;
  offset?: number;
}

// UI/dataset listing (spec section 16: always its own table/query, never
// joined with real trade_outcomes rows).
export async function listShadowTrades(pool: Pool, options: ListShadowTradesOptions = {}): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }
  if (options.symbol) {
    params.push(options.symbol);
    conditions.push(`symbol = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;

  const [rows, count] = await Promise.all([
    pool.query(`SELECT * FROM shadow_trades ${where} ORDER BY created_at DESC LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`, [...params, limit, offset]),
    pool.query(`SELECT count(*)::int AS n FROM shadow_trades ${where}`, params),
  ]);
  return { rows: rows.rows, total: Number(count.rows[0]?.n ?? 0) };
}
