# Phase 16 Alpaca Paper Trading

Phase 16 integrates Alpaca paper trading for US stocks. It does not add live
trading or real-money execution.

## Broker Selection

The default broker remains the local `PaperBrokerAdapter`.

Enable Alpaca paper trading with:

```powershell
$env:BROKER_PROVIDER = "alpaca_paper"
$env:ALPACA_PAPER_API_KEY_ID = "..."
$env:ALPACA_PAPER_API_SECRET_KEY = "..."
```

Optional:

```powershell
$env:ALPACA_PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets"
```

The adapter rejects Alpaca live trading base URLs. The default base URL is
`https://paper-api.alpaca.markets`; requests are sent under `/v2`.

## Supported Operations

- Submit US stock paper orders through `POST /v2/orders`
- Cancel paper orders through `DELETE /v2/orders/{order_id}`
- Fetch paper orders through `GET /v2/orders/{order_id}`
- Fetch by `client_order_id` through `GET /v2/orders:by_client_order_id`
- Sync account cash through `GET /v2/account`
- Sync open positions through `GET /v2/positions`
- Sync open orders through `GET /v2/orders?status=open`

## Idempotency

The internal `idempotency_key` is sent to Alpaca as `client_order_id`.
Before posting a new order, the adapter queries by `client_order_id`; if Alpaca
already has that order, the existing order is returned and no duplicate order is
submitted.

## State Mapping

Alpaca paper order states are mapped to internal order states:

- `filled` -> `FILLED`
- `partially_filled` -> `PARTIALLY_FILLED`
- `canceled`, `expired` -> `CANCELLED`
- `rejected`, `stopped`, `suspended` -> `REJECTED`
- `pending_new`, `accepted`, `new`, `accepted_for_bidding` -> `PENDING`
- `pending_cancel`, `pending_replace`, `replaced`, `done_for_day`, `calculated` -> `SUBMITTED`
- unknown states -> `ERROR`

## Safety Boundary

The adapter is still a paper broker. The Node execution service keeps the Phase
13 execution-time safety gate: `trading_mode` must be `PAPER` and the kill
switch must be enabled before broker submission.

All tests use mocked Alpaca responses; no network calls to Alpaca are required.
