import { Pool, PoolClient } from 'pg';

export type HourlyCandleProcessingStatus = 'CLAIMED' | 'ANALYZED' | 'ERROR';

export interface HourlyCandleClaim {
  id: string;
  symbol: string;
  candleTimestamp: Date;
  status: HourlyCandleProcessingStatus;
}

function mapRow(row: Record<string, unknown>): HourlyCandleClaim {
  return {
    id: row.id as string,
    symbol: row.symbol as string,
    candleTimestamp: row.candle_timestamp as Date,
    status: row.status as HourlyCandleProcessingStatus,
  };
}

/** Atomically claims a (symbol, candleTimestamp) pair via the table's
 * UNIQUE constraint — the caller that wins the INSERT is the only one
 * permitted to analyze that candle. Returns null if another caller (or a
 * prior run before a restart) already claimed it. This is the entire
 * "one signal max per symbol per completed 1H candle, restart-safe"
 * guarantee — no in-memory state is involved. */
export async function claimCandle(
  db: Pool | PoolClient,
  symbol: string,
  candleTimestamp: Date,
): Promise<HourlyCandleClaim | null> {
  const { rows } = await db.query(
    `INSERT INTO hourly_candle_processing (symbol, candle_timestamp, status)
     VALUES ($1, $2, 'CLAIMED')
     ON CONFLICT (symbol, candle_timestamp) DO NOTHING
     RETURNING *`,
    [symbol, candleTimestamp],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function markCandleAnalyzed(
  db: Pool | PoolClient,
  id: string,
  signalId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE hourly_candle_processing
     SET status = 'ANALYZED', signal_id = $2, completed_at = NOW()
     WHERE id = $1`,
    [id, signalId],
  );
}

export async function markCandleError(
  db: Pool | PoolClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  await db.query(
    `UPDATE hourly_candle_processing
     SET status = 'ERROR', error_message = $2, completed_at = NOW()
     WHERE id = $1`,
    [id, errorMessage],
  );
}

/** The most recent candle already claimed for a symbol — the scheduler's
 * "have I already acted on this candle" check, sourced from the database
 * (not scheduler memory) so it survives a process restart unchanged. */
export async function findLastProcessedCandle(
  db: Pool | PoolClient,
  symbol: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ candle_timestamp: Date }>(
    `SELECT MAX(candle_timestamp) AS candle_timestamp
     FROM hourly_candle_processing
     WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.candle_timestamp ?? null;
}

export async function listRecentCandleProcessing(
  db: Pool | PoolClient,
  limit = 50,
): Promise<HourlyCandleClaim[]> {
  const { rows } = await db.query(
    `SELECT * FROM hourly_candle_processing
     ORDER BY candle_timestamp DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}
