# Phase 14 US Stocks Market Data

Phase 14 adds Alpaca US stock market data while keeping all order execution
paper-only. The broker path is unchanged and still uses `PaperBrokerAdapter`.

## Providers

`MarketDataProvider` remains the abstraction used by strategies, risk checks,
and the paper broker.

- `synthetic`: default provider for local development and fallback.
- `csv`: replay provider for deterministic tests and local data.
- `alpaca`: US stocks provider for Alpaca Market Data API.

Enable Alpaca market data with:

```powershell
$env:MARKET_DATA_PROVIDER = "alpaca"
$env:ALPACA_API_KEY_ID = "..."
$env:ALPACA_API_SECRET_KEY = "..."
$env:ALPACA_DATA_FEED = "iex"
$env:MARKET_DATA_SYMBOLS = "AAPL,MSFT,SPY"
```

Optional settings:

- `ALPACA_DATA_BASE_URL`: defaults to `https://data.alpaca.markets`
- `ALPACA_STREAM_URL`: defaults to `wss://stream.data.alpaca.markets`
- `MARKET_DATA_STALENESS_SECONDS`: defaults to `60`

The default feed is `iex` so local paper trading can work with common Alpaca
plans. Use `sip` only when the Alpaca subscription allows it.

## Supported Data

- Snapshots via `/v2/stocks/{symbol}/snapshot`
- Historical bars via `/v2/stocks/{symbol}/bars`
- Latest quote via `/v2/stocks/{symbol}/quotes/latest`
- Latest trade via `/v2/stocks/{symbol}/trades/latest`
- Real-time stream via `wss://stream.data.alpaca.markets/v2/{feed}`

All timestamps are parsed as UTC-aware `datetime` values. Snapshot, quote, and
trade responses include freshness checks against `MARKET_DATA_STALENESS_SECONDS`.

## Reliability

- REST calls preserve Alpaca `429` rate-limit responses as
  `MarketDataRateLimitError` with `Retry-After` when present.
- REST 5xx responses become provider errors so callers can return service
  unavailable without using stale data silently.
- WebSocket streaming authenticates, subscribes to trades, quotes, and bars,
  records the last error, and reconnects with exponential backoff until stopped.

## Execution Boundary

This phase does not add live trading. Alpaca is used only for market data.
Paper order execution remains isolated in the trading engine paper broker.
