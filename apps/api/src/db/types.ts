// TypeScript interfaces for all database entities.
// Monetary / quantity values arrive from pg as strings (NUMERIC → string).
// Never convert these to number — use Decimal.js for arithmetic.

export type SignalStatus = 'CREATED' | 'RISK_PASS' | 'RISK_FAIL' | 'EXPIRED';
export type RiskResult = 'PASS' | 'REJECT';
export type RiskCheckStage = 'PRE_PROPOSAL' | 'PRE_EXECUTION';
export type ProposalStatus =
  | 'RISK_CHECKING'
  | 'RISK_REJECTED'
  | 'PENDING_APPROVAL'
  | 'OWNER_REJECTED'
  | 'EXPIRED'
  | 'APPROVED'
  | 'REVALIDATING'
  | 'RISK_REJECTED_AFTER_APPROVAL'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'EXECUTION_REJECTED'
  | 'EXECUTION_ERROR';
export type ExecutionStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ERROR';
export type OrderStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ERROR';

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface Strategy {
  id: string;
  name: string;
  description: string | null;
  version: string;
  parameters: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Signal {
  id: string;
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  referencePrice: string;  // NUMERIC(18,8)
  reason: string;
  strategyVersion: string;
  confidence: string | null;  // NUMERIC(5,4)
  marketSnapshot: Record<string, unknown>;
  status: SignalStatus;
  createdAt: Date;
  expiresAt: Date;
}

export interface RiskCheck {
  id: string;
  signalId: string | null;
  proposalId: string | null;
  stage: RiskCheckStage;
  result: RiskResult;
  rulesChecked: string[];
  failedRules: string[];
  reason: string | null;
  marketSnapshot: Record<string, unknown>;
  portfolioSnapshot: Record<string, unknown>;
  createdAt: Date;
}

export interface TradeProposal {
  id: string;
  signalId: string;
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;          // NUMERIC(18,8)
  orderType: 'MARKET' | 'LIMIT';
  referencePrice: string;    // NUMERIC(18,8)
  limitPrice: string | null; // NUMERIC(18,8)
  estimatedNotional: string; // NUMERIC(18,8)
  riskCheckId: string | null;
  riskSnapshot: Record<string, unknown>;
  portfolioSnapshot: Record<string, unknown>;
  status: ProposalStatus;
  createdAt: Date;
  pendingApprovalAt: Date | null;
  expiresAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  filledAt: Date | null;
  updatedAt: Date;
  notes: string | null;
}

export interface TradeApproval {
  id: string;
  proposalId: string;
  approvedBy: string;
  action: 'APPROVE' | 'REJECT';
  reason: string | null;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface Execution {
  id: string;
  proposalId: string;
  idempotencyKey: string;
  brokerOrderId: string | null;
  status: ExecutionStatus;
  attemptNumber: number;
  errorMessage: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface Order {
  id: string;
  executionId: string;
  brokerOrderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;          // NUMERIC(18,8)
  orderType: string;
  limitPrice: string | null; // NUMERIC(18,8)
  status: OrderStatus;
  filledQuantity: string;    // NUMERIC(18,8)
  averageFillPrice: string | null; // NUMERIC(18,8)
  bracketOrderIds: Record<string, string | null>;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'OTHER' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Fill {
  id: string;
  orderId: string;
  quantity: string;    // NUMERIC(18,8)
  price: string;       // NUMERIC(18,8)
  fee: string;         // NUMERIC(18,8)
  fillType: 'FULL' | 'PARTIAL';
  brokerFillId: string | null;
  filledAt: Date;
}

export interface Position {
  id: string;
  symbol: string;
  quantity: string;           // NUMERIC(18,8)
  averageEntryPrice: string | null; // NUMERIC(18,8)
  realizedPnl: string;        // NUMERIC(18,8)
  unrealizedPnl: string;      // NUMERIC(18,8)
  lastPrice: string | null;   // NUMERIC(18,8)
  lastPriceAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioSnapshot {
  id: string;
  cashBalance: string;     // NUMERIC(18,8)
  portfolioEquity: string; // NUMERIC(18,8)
  openPositions: unknown[];
  pendingOrders: unknown[];
  realizedPnl: string;     // NUMERIC(18,8)
  unrealizedPnl: string;   // NUMERIC(18,8)
  dailyPnl: string;        // NUMERIC(18,8)
  snapshotReason: string;
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  eventType: string;
  actorId: string | null;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  action: string;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface SystemSetting {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}
