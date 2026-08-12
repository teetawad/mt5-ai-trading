import { describe, expect, it } from 'vitest';
import {
  calculatePortfolioPnl,
  calculatePositionAccounting,
  PositionAccountingError,
} from '../services/trade-execution-service';
import { FillEventDTO } from '../services/trading-engine-client';

function fill(quantity: string, price: string, fee: string): FillEventDTO {
  return {
    order_id: `order-${price}-${quantity}`,
    fill_id: `fill-${price}-${quantity}`,
    quantity,
    price,
    fee,
    is_partial: false,
    filled_at: '2026-08-12T00:00:00.000Z',
  };
}

describe('position accounting', () => {
  it('realizes profit on a profitable full round trip', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.00000000', '0.00000000')]);
    const closed = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '105.00000000', '0.00000000')]);

    expect(closed.quantity).toBe('0.00000000');
    expect(closed.averageEntryPrice).toBeNull();
    expect(closed.realizedPnl).toBe('5.00000000');
    expect(closed.unrealizedPnl).toBe('0.00000000');
  });

  it('realizes loss on a losing full round trip', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.00000000', '0.00000000')]);
    const closed = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '97.93000000', '0.00000000')]);

    expect(closed.quantity).toBe('0.00000000');
    expect(closed.realizedPnl).toBe('-2.07000000');
  });

  it('capitalizes buy fees and subtracts sell fees from realized P&L', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.00000000', '1.00000000')]);
    const closed = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '105.00000000', '1.00000000')]);

    expect(opened.averageEntryPrice).toBe('101.00000000');
    expect(closed.realizedPnl).toBe('3.00000000');
  });

  it('reflects slippage through the broker fill prices', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.05000000', '0.00000000')]);
    const closed = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '99.95000000', '0.00000000')]);

    expect(closed.realizedPnl).toBe('-0.10000000');
  });

  it('realizes P&L on a partial close and keeps remaining average cost', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('2.00000000', '100.00000000', '2.00000000')]);
    const partiallyClosed = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '110.00000000', '1.00000000')]);

    expect(opened.averageEntryPrice).toBe('101.00000000');
    expect(partiallyClosed.quantity).toBe('1.00000000');
    expect(partiallyClosed.averageEntryPrice).toBe('101.00000000');
    expect(partiallyClosed.realizedPnl).toBe('8.00000000');
    expect(partiallyClosed.unrealizedPnl).toBe('9.00000000');
  });

  it('keeps cumulative realized P&L after a full close', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('2.00000000', '100.00000000', '2.00000000')]);
    const partial = calculatePositionAccounting(opened, 'SELL', [fill('1.00000000', '110.00000000', '1.00000000')]);
    const closed = calculatePositionAccounting(partial, 'SELL', [fill('1.00000000', '95.00000000', '1.00000000')]);

    expect(closed.quantity).toBe('0.00000000');
    expect(closed.averageEntryPrice).toBeNull();
    expect(closed.realizedPnl).toBe('1.00000000');
    expect(closed.unrealizedPnl).toBe('0.00000000');
  });

  it('derives closed-portfolio realized P&L from cash and initial paper cash', () => {
    const pnl = calculatePortfolioPnl('100000.00000000', '99997.93000000', []);

    expect(pnl.portfolioEquity).toBe('99997.93000000');
    expect(pnl.realizedPnl).toBe('-2.07000000');
    expect(pnl.unrealizedPnl).toBe('0.00000000');
  });

  it('does not count stale closed-position realized P&L again on a later flat portfolio', () => {
    const staleClosedPosition = {
      symbol: 'AAPL',
      quantity: '0.00000000',
      averageEntryPrice: null,
      lastPrice: '99.93000000',
    };
    const pnl = calculatePortfolioPnl('100000.00000000', '99997.72000000', [staleClosedPosition]);

    expect(pnl.portfolioEquity).toBe('99997.72000000');
    expect(pnl.realizedPnl).toBe('-2.28000000');
    expect(pnl.unrealizedPnl).toBe('0.00000000');
  });

  it('keeps the cash/equity invariant across multiple sequential round trips', () => {
    let cash = 100000;

    const firstOpen = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.00000000', '1.00000000')]);
    cash -= 101;
    const firstClosed = calculatePositionAccounting(firstOpen, 'SELL', [fill('1.00000000', '99.93000000', '1.00000000')]);
    cash += 98.93;
    const firstPnl = calculatePortfolioPnl('100000.00000000', cash.toFixed(8), []);

    const secondOpen = calculatePositionAccounting(firstClosed, 'BUY', [fill('1.00000000', '100.00000000', '1.00000000')]);
    cash -= 101;
    const secondClosed = calculatePositionAccounting(secondOpen, 'SELL', [fill('1.00000000', '99.72000000', '1.00000000')]);
    cash += 98.72;
    const secondPnl = calculatePortfolioPnl('100000.00000000', cash.toFixed(8), []);

    expect(firstClosed.realizedPnl).toBe('-2.07000000');
    expect(secondClosed.realizedPnl).toBe('-4.35000000');
    expect(firstPnl.realizedPnl).toBe('-2.07000000');
    expect(secondPnl.realizedPnl).toBe('-4.35000000');
    expect(Number(secondPnl.portfolioEquity)).toBeCloseTo(100000 + Number(secondPnl.realizedPnl), 8);
  });

  it('subtracts unrealized P&L from equity when deriving cumulative realized P&L with an open position', () => {
    const openPositions = [
      {
        symbol: 'AAPL',
        quantity: '1.00000000',
        averageEntryPrice: '101.00000000',
        lastPrice: '110.00000000',
      },
    ];
    const pnl = calculatePortfolioPnl('100000.00000000', '99907.00000000', openPositions);

    expect(pnl.portfolioEquity).toBe('100017.00000000');
    expect(pnl.unrealizedPnl).toBe('9.00000000');
    expect(pnl.realizedPnl).toBe('8.00000000');
  });

  it('prefers live market price over stale stored lastPrice for unrealized/realized P&L', () => {
    const openPositions = [
      {
        symbol: 'AAPL',
        quantity: '10.00000000',
        averageEntryPrice: '100.00000000',
        lastPrice: '100.00000000',
      },
    ];
    const stale = calculatePortfolioPnl('100000.00000000', '99000.00000000', openPositions);
    expect(stale.unrealizedPnl).toBe('0.00000000');
    expect(stale.portfolioEquity).toBe('100000.00000000');

    const live = calculatePortfolioPnl('100000.00000000', '99000.00000000', openPositions, {
      AAPL: '150.00000000',
    });
    expect(live.unrealizedPnl).toBe('500.00000000');
    expect(live.portfolioEquity).toBe('100500.00000000');
    expect(live.realizedPnl).toBe('0.00000000');
  });

  it('falls back to stored lastPrice when a symbol has no live market price', () => {
    const openPositions = [
      {
        symbol: 'MSFT',
        quantity: '5.00000000',
        averageEntryPrice: '200.00000000',
        lastPrice: '210.00000000',
      },
    ];
    const pnl = calculatePortfolioPnl('100000.00000000', '99000.00000000', openPositions, {
      AAPL: '150.00000000',
    });
    expect(pnl.unrealizedPnl).toBe('50.00000000');
  });

  it('throws instead of fabricating P&L when a SELL fill exceeds the tracked position', () => {
    const opened = calculatePositionAccounting(null, 'BUY', [fill('1.00000000', '100.00000000', '0.00000000')]);

    expect(() => calculatePositionAccounting(
      opened,
      'SELL',
      [fill('5.00000000', '110.00000000', '0.00000000')],
    )).toThrow(PositionAccountingError);
  });
});
