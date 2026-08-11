import Decimal from 'decimal.js';
import { MarketSnapshotDTO } from './trading-engine-client';

export type AiDecisionAction = 'BUY' | 'SELL' | 'HOLD';

export interface AiDecision {
  phase: '23';
  source: 'AI_ASSISTED_DECISION';
  model: string;
  strategyVersion: string;
  decision: AiDecisionAction;
  confidence: string;
  reasons: string[];
  proposedEntry: string;
  stopLoss: string | null;
  takeProfit: string | null;
  riskReward: string | null;
  suggestedPositionSize: string;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export function analyzeUsStock(
  market: MarketSnapshotDTO,
  options: {
    requestedSide?: 'BUY' | 'SELL' | 'HOLD';
    requestedQuantity?: string;
    model?: string;
    strategyVersion?: string;
  } = {},
): AiDecision {
  const price = new Decimal(market.price);
  const decision = options.requestedSide ?? (market.is_stale ? 'HOLD' : 'BUY');
  const stopLoss = decision === 'BUY' ? price.mul('0.98') : decision === 'SELL' ? price.mul('1.02') : null;
  const takeProfit = decision === 'BUY' ? price.mul('1.04') : decision === 'SELL' ? price.mul('0.96') : null;
  const riskReward = stopLoss && takeProfit
    ? takeProfit.minus(price).abs().div(price.minus(stopLoss).abs())
    : null;

  return {
    phase: '23',
    source: 'AI_ASSISTED_DECISION',
    model: options.model ?? 'deterministic-phase23-local',
    strategyVersion: options.strategyVersion ?? '23.0.0',
    decision,
    confidence: decision === 'HOLD' ? '0.5000' : '0.7200',
    reasons: decision === 'HOLD'
      ? ['AI decision is HOLD; no trade proposal should be created.']
      : [
        `Market data for ${market.symbol} is ${market.is_stale ? 'stale' : 'fresh'}.`,
        `Suggested ${decision} uses a predefined PAPER bracket risk template.`,
      ],
    proposedEntry: money(price),
    stopLoss: stopLoss ? money(stopLoss) : null,
    takeProfit: takeProfit ? money(takeProfit) : null,
    riskReward: riskReward ? money(riskReward) : null,
    suggestedPositionSize: options.requestedQuantity ?? '1.00000000',
  };
}
