import { Pool } from 'pg';
import { cancelMt5PendingOrder, listMt5PendingOrders, listMt5Positions } from '../mt5-client';
import { Mt5Actor } from '../mt5-entry-plan-watcher';
import { planComment } from './plan-comment';

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface Mt5EvidenceForPlan {
  matchedOrder: Record<string, unknown> | null;
  matchedPosition: Record<string, unknown> | null;
}

/**
 * Finds whatever MT5 evidence (if any) proves a plan's execution_key/comment
 * already resulted in a real pending order or position — the single shared
 * lookup used both by the watcher's delayed self-heal (reconcileStuckSubmissions)
 * and by an owner's immediate retry click (approveAndPlaceAiTradePlan), so a
 * plan can never be double-submitted to MT5 no matter which path notices it
 * first (spec section 8: "search for an existing order linked to the same
 * execution_key" before ever sending another order_send).
 */
export function findMt5EvidenceForPlan(
  row: Record<string, unknown>,
  pendingOrders: Record<string, unknown>[],
  positions: Record<string, unknown>[],
): Mt5EvidenceForPlan {
  const comment = planComment(row.id);
  const matchedOrder = pendingOrders.find((order) => String(order.symbol) === row.symbol && String(order.comment ?? '') === comment) ?? null;
  const matchedPosition = positions.find((position) => String(position.symbol) === row.symbol && String(position.comment ?? '') === comment) ?? null;
  return { matchedOrder, matchedPosition };
}

/**
 * Expires AI trade plans that were never approved before plan_expiry (spec
 * section 9: "Never leave obsolete AI pending orders active indefinitely").
 * Only touches plans that never reached MT5 — a real pending order gets
 * cancelled in MT5 first, below, before its plan is ever marked EXPIRED.
 */
async function expireUnapprovedPlans(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE ai_trade_plans SET status='PLAN_EXPIRED', expired_at=now(), updated_at=now()
     WHERE status IN ('AI_PLAN_CREATED','WAITING_FOR_APPROVAL') AND plan_expiry <= now()`,
  );
}

/**
 * Every PENDING_ORDER_PLACED plan corresponds to a REAL MT5 pending order —
 * this reconciles what actually happened to it: still pending, expired (must
 * be actively cancelled in MT5, never just forgotten locally), triggered
 * into a real position, or cancelled/rejected by the broker itself.
 */
async function reconcilePendingOrders(pool: Pool, actor: Mt5Actor): Promise<void> {
  const rows = await pool.query(`SELECT * FROM ai_trade_plans WHERE status='PENDING_ORDER_PLACED'`);
  if (!rows.rows.length) return;

  const [pendingOrders, positions] = await Promise.all([
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => null),
    listMt5Positions(actor.requestId ?? undefined).catch(() => null),
  ]);
  if (pendingOrders === null || positions === null) return; // MT5 unreachable this tick — never guess, retry next tick.

  const pendingTickets = new Set(pendingOrders.map((order) => String(order.ticket ?? '')));

  for (const row of rows.rows) {
    const ticket = String(row.mt5_order_ticket ?? '');
    const expired = new Date(String(row.plan_expiry)).getTime() <= Date.now();

    if (pendingTickets.has(ticket)) {
      if (expired) {
        try {
          await cancelMt5PendingOrder(ticket, actor.requestId ?? undefined);
          await pool.query(
            `UPDATE ai_trade_plans SET status='PLAN_EXPIRED', expired_at=now(), updated_at=now() WHERE id=$1 AND status='PENDING_ORDER_PLACED'`,
            [row.id],
          );
        } catch (err) {
          console.warn(`[ai-trade-plan-watcher] failed to cancel expired pending order ${ticket}:`, (err as Error).message);
        }
      }
      continue; // still genuinely pending in MT5, nothing else to do this tick.
    }

    // Ticket no longer in orders_get() — either it triggered into a position
    // or the broker cancelled/rejected it. Match by comment (short, plan-id
    // derived — see planComment) since MT5 does not otherwise link a
    // resulting position back to the pending order that created it.
    const comment = planComment(row.id);
    const matched = positions.find((position) => String(position.symbol) === row.symbol && String(position.comment ?? '') === comment);
    if (matched) {
      const actualEntry = numberOrNull(matched.price_open) ?? row.entry_price;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO trade_outcomes(symbol, ai_trade_plan_id, order_ticket, side, volume, expected_entry,
              actual_entry, stop_loss, take_profit, risk_amount, risk_reward, opened_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (ai_trade_plan_id) WHERE ai_trade_plan_id IS NOT NULL DO NOTHING`,
          [row.symbol, row.id, String(matched.ticket ?? ticket), row.decision, matched.volume ?? row.final_volume, row.entry_price, actualEntry, row.stop_loss, row.take_profit, row.max_planned_loss, row.risk_reward],
        );
        await client.query(
          `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_position_ticket=$3, updated_at=now() WHERE id=$1 AND status='PENDING_ORDER_PLACED'`,
          [row.id, actualEntry, String(matched.ticket ?? '')],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      continue;
    }

    // No pending order and no matching position: the broker cancelled or
    // rejected it outside this app's control.
    await pool.query(
      `UPDATE ai_trade_plans SET status='ORDER_CANCELLED', cancelled_at=now(), blocked_reason='MT5_ORDER_NO_LONGER_PENDING', updated_at=now() WHERE id=$1 AND status='PENDING_ORDER_PLACED'`,
      [row.id],
    );
  }
}

/**
 * A plan can get stuck in PENDING_ORDER_SUBMITTING if the API crashes/restarts
 * mid-request. Mirrors mt5-entry-plan-watcher's reconcileStuckExecutions:
 * check local trade_outcomes, then live MT5 orders/positions by comment,
 * before ever releasing the plan back for a fresh, fully re-checked retry.
 */
async function reconcileStuckSubmissions(pool: Pool, actor: Mt5Actor, graceSeconds = 120): Promise<void> {
  const stuck = await pool.query(
    `SELECT * FROM ai_trade_plans WHERE status='PENDING_ORDER_SUBMITTING' AND submitting_at <= now() - ($1 || ' seconds')::interval`,
    [graceSeconds],
  );
  if (!stuck.rows.length) return;

  const [pendingOrders, positions] = await Promise.all([
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
  ]);

  for (const row of stuck.rows) {
    const { matchedOrder, matchedPosition } = findMt5EvidenceForPlan(row, pendingOrders, positions);
    if (matchedOrder) {
      await pool.query(
        `UPDATE ai_trade_plans SET status='PENDING_ORDER_PLACED', placed_at=now(), mt5_order_ticket=$2, execution_key=NULL, updated_at=now() WHERE id=$1`,
        [row.id, String(matchedOrder.ticket ?? '')],
      );
      continue;
    }
    if (matchedPosition) {
      await pool.query(
        `UPDATE ai_trade_plans SET status='POSITION_OPEN', actual_entry=$2, mt5_position_ticket=$3, execution_key=NULL, updated_at=now() WHERE id=$1`,
        [row.id, numberOrNull(matchedPosition.price_open) ?? row.entry_price, String(matchedPosition.ticket ?? '')],
      );
      continue;
    }
    // Neither a pending order nor a position exists in MT5 for this plan —
    // safe to release for a fresh, fully re-checked retry.
    await pool.query(
      `UPDATE ai_trade_plans SET status='WAITING_FOR_APPROVAL', submitting_at=NULL, execution_key=NULL, updated_at=now() WHERE id=$1`,
      [row.id],
    );
  }
}

/**
 * Once trade_outcomes closes a row (via the existing, unmodified
 * reconcileOpenTradeOutcomes in mt5-entry-plan-watcher.ts, which already
 * runs generically over every open trade_outcomes row regardless of which
 * plan table created it), this syncs the linked ai_trade_plans row's status
 * so History/Open Trades never have to cross-reference two tables to know a
 * plan's true state.
 */
async function syncClosedPlans(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE ai_trade_plans p SET status='POSITION_CLOSED', updated_at=now()
     FROM trade_outcomes t
     WHERE t.ai_trade_plan_id = p.id AND t.closed_at IS NOT NULL AND t.exit_reason <> 'RECONCILIATION_FAILED'
       AND p.status = 'POSITION_OPEN'`,
  );
  await pool.query(
    `UPDATE ai_trade_plans p SET status='EXECUTION_FAILED', blocked_reason='RECONCILIATION_FAILED', updated_at=now()
     FROM trade_outcomes t
     WHERE t.ai_trade_plan_id = p.id AND t.exit_reason = 'RECONCILIATION_FAILED'
       AND p.status = 'POSITION_OPEN'`,
  );
}

const SYSTEM_ACTOR: Mt5Actor = {
  actorId: null,
  actorEmail: 'ai-trade-plan-watcher@internal',
  requestId: 'ai-trade-plan-watcher',
};

export async function runAiTradePlanWatcherTick(pool: Pool, actor: Mt5Actor = SYSTEM_ACTOR): Promise<void> {
  await expireUnapprovedPlans(pool).catch((err) => console.warn('[ai-trade-plan-watcher] expire failed:', (err as Error).message));
  await reconcileStuckSubmissions(pool, actor).catch((err) => console.warn('[ai-trade-plan-watcher] stuck-submission reconciliation failed:', (err as Error).message));
  await reconcilePendingOrders(pool, actor).catch((err) => console.warn('[ai-trade-plan-watcher] pending-order reconciliation failed:', (err as Error).message));
  await syncClosedPlans(pool).catch((err) => console.warn('[ai-trade-plan-watcher] closed-plan sync failed:', (err as Error).message));
}

let watcherStarted = false;

export function startAiTradePlanWatcher(pool: Pool): void {
  const intervalMs = Number(process.env.AI_TRADE_PLAN_WATCHER_INTERVAL_MS ?? 15_000);
  const tick = () => {
    runAiTradePlanWatcherTick(pool).catch((err) => console.error('[ai-trade-plan-watcher] tick failed:', err));
  };
  watcherStarted = true;
  setTimeout(tick, 3_000);
  setInterval(tick, intervalMs);
}

export function isAiTradePlanWatcherStarted(): boolean {
  return watcherStarted;
}

export { expireUnapprovedPlans, reconcilePendingOrders, reconcileStuckSubmissions, syncClosedPlans };
