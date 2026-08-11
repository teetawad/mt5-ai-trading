import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb, withTransaction } from './setup';
import { createAuditLog } from '../../db/repositories/audit-logs';
import { createStrategy } from '../../db/repositories/strategies';
import { createSignal } from '../../db/repositories/signals';
import { createRiskCheck } from '../../db/repositories/risk-checks';
import { createProposal, updateProposalStatus } from '../../db/repositories/trade-proposals';

const SKIP = !process.env.TEST_DATABASE_URL;

describe('audit_logs immutability trigger', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (SKIP) return;
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it.skipIf(SKIP)('prevents UPDATE on audit_logs', async () => {
    await withTransaction(pool, async (client) => {
      const log = await createAuditLog(client, {
        eventType: 'TEST',
        action: 'test_action',
      });
      await expect(
        client.query('UPDATE audit_logs SET action = $1 WHERE id = $2', ['modified', log.id]),
      ).rejects.toThrow('immutable');
    });
  });

  it.skipIf(SKIP)('prevents DELETE on audit_logs', async () => {
    await withTransaction(pool, async (client) => {
      const log = await createAuditLog(client, {
        eventType: 'TEST',
        action: 'test_action',
      });
      await expect(
        client.query('DELETE FROM audit_logs WHERE id = $1', [log.id]),
      ).rejects.toThrow('immutable');
    });
  });
});

describe('trade_proposals field immutability trigger', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (SKIP) return;
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function makeProposal(client: import('pg').PoolClient) {
    const strategy = await createStrategy(client, {
      name: `strat-${Date.now()}-${Math.random()}`,
      version: '1.0.0',
    });
    const signal = await createSignal(client, {
      strategyId: strategy.id,
      symbol: 'AAPL',
      side: 'BUY',
      referencePrice: '150.00',
      reason: 'test',
      strategyVersion: '1.0.0',
      marketSnapshot: {},
      expiresAt: new Date(Date.now() + 600_000),
    });
    const riskCheck = await createRiskCheck(client, {
      signalId: signal.id,
      stage: 'PRE_PROPOSAL',
      result: 'PASS',
      rulesChecked: ['rule_a'],
      marketSnapshot: {},
      portfolioSnapshot: {},
    });
    return createProposal(client, {
      signalId: signal.id,
      strategyId: strategy.id,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10.00000000',
      orderType: 'MARKET',
      referencePrice: '150.00000000',
      estimatedNotional: '1500.00000000',
      riskCheckId: riskCheck.id,
      riskSnapshot: {},
      portfolioSnapshot: {},
      expiresAt: new Date(Date.now() + 600_000),
    });
  }

  it.skipIf(SKIP)('allows trading parameter update while in RISK_CHECKING', async () => {
    await withTransaction(pool, async (client) => {
      const proposal = await makeProposal(client);
      // Should not throw — RISK_CHECKING is not a locked status
      await expect(
        client.query(
          'UPDATE trade_proposals SET quantity = $1 WHERE id = $2',
          ['20.00000000', proposal.id],
        ),
      ).resolves.toBeDefined();
    });
  });

  it.skipIf(SKIP)('blocks trading parameter update after PENDING_APPROVAL', async () => {
    await withTransaction(pool, async (client) => {
      const proposal = await makeProposal(client);
      await updateProposalStatus(client, proposal.id, 'PENDING_APPROVAL', {
        pendingApprovalAt: new Date(),
      });
      await expect(
        client.query(
          'UPDATE trade_proposals SET quantity = $1 WHERE id = $2',
          ['20.00000000', proposal.id],
        ),
      ).rejects.toThrow('Cannot modify trading parameters');
    });
  });

  it.skipIf(SKIP)('allows non-trading-parameter update after PENDING_APPROVAL', async () => {
    await withTransaction(pool, async (client) => {
      const proposal = await makeProposal(client);
      await updateProposalStatus(client, proposal.id, 'PENDING_APPROVAL', {
        pendingApprovalAt: new Date(),
      });
      // notes is not a locked field — should succeed
      await expect(
        client.query(
          'UPDATE trade_proposals SET notes = $1 WHERE id = $2',
          ['a note', proposal.id],
        ),
      ).resolves.toBeDefined();
    });
  });
});
