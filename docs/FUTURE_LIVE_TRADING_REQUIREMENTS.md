# FUTURE_LIVE_TRADING_REQUIREMENTS.md

## WARNING

This document describes ARCHITECTURE DISCUSSION ONLY.

The current codebase does NOT implement live trading.
No live broker SDK is installed. No live broker credentials exist.
Do not implement any items in this document without a separate architecture review
and explicit written owner approval.

---

## Purpose

This document captures the additional requirements and risks that must be addressed
before live trading could ever be considered. It exists to ensure the paper trading
architecture is designed with a clean seam for future extension — not to encourage
or enable live trading prematurely.

---

## What Would Change

### 1. LiveBrokerAdapter

A new `LiveBrokerAdapter` implementing the existing `BrokerAdapter` interface would be created.
No changes to the execution logic would be needed — only the adapter implementation.

The adapter would:
- Connect to a real broker API (to be determined).
- Submit real orders.
- Receive real fills.
- Handle real partial fills, cancellations, and rejections.

The `PaperBrokerAdapter` would remain as the default. A configuration flag would select
which adapter is used — and that flag would be server-controlled only, never frontend-controlled.

### 2. Broker Credential Management

Real broker API keys would need:
- Secure storage (secrets manager, not environment variables).
- Key rotation capability.
- Audit log of key usage.
- Separate paper and live credentials (never share keys).

### 3. Enhanced Authentication

Live trading would require stronger authentication than a single password:
- WebAuthn / passkeys.
- TOTP (authenticator app).
- Or hardware security key.
Single-factor authentication is insufficient for real-money approval.

### 4. Enhanced Approval Workflow

- Explicit confirmation with displayed risk metrics.
- Possibly a time-delay between approval and execution (cooling-off period).
- Multi-factor re-authentication at approval time.
- Approval confirmation on a separate device (future).

### 5. Regulatory Considerations

Live trading may trigger regulatory obligations depending on jurisdiction:
- Trade reporting requirements.
- Record-keeping requirements.
- Pattern Day Trader rules (US).
- Tax lot accounting.
These would require additional database tables and reporting capabilities.

### 6. Network Security

- mTLS between `apps/api` and the broker API.
- No live broker credentials in environment variables — use a secrets manager.
- All broker communication logged.
- IP allowlisting at the broker side.

### 7. Enhanced Risk Controls

- Real-time position limits checked against broker state, not just local DB.
- Broker-side position limits as a secondary control.
- Automated circuit breaker (not just kill switch).
- Broker-confirmed position reconciliation before and after every order.

### 8. Reconciliation

- The local portfolio state must be reconciled against broker state regularly.
- Any discrepancy must halt trading and trigger an alert.
- Fills received from broker must match fills recorded locally.

### 9. Market Data

- Live trading requires real-time, low-latency market data.
- A paid market data provider would be required.
- Data license agreements must be reviewed.

### 10. Disaster Recovery

- State of open orders must survive a full application restart.
- Broker order IDs must be persisted before execution is committed as "submitted."
- Reconciliation on startup to detect any orders submitted but not confirmed.

---

## Architecture Seams Already In Place

The paper trading architecture already provides:

- `BrokerAdapter` interface — clean extension point for `LiveBrokerAdapter`.
- `MarketDataProvider` interface — clean extension point for live data feeds.
- Idempotency on execution — prevents duplicates on retry.
- Audit log — append-only, tamper-resistant.
- State machine — explicit transitions, no implicit state.
- Two-phase risk validation — already correct for live trading.
- `trading_mode` system setting — controls which mode is active.

---

## What Must NOT Change When Adding Live Trading

- The risk engine must still run twice.
- Owner approval must still be required.
- Kill switch must still be enforced server-side.
- Audit log must still be written.
- Idempotency must still be enforced.
- The frontend must still send only a proposal ID during approval.

---

## Open Questions for Live Trading (Do Not Resolve Now)

1. Which broker? (Different brokers have different order types, fee structures, and APIs.)
2. Which market data provider?
3. Jurisdiction and regulatory requirements.
4. Tax lot accounting method (FIFO, LIFO, specific lot)?
5. Position reconciliation frequency.
6. Emergency stop mechanism (beyond kill switch).
7. Incident response procedure if an erroneous order is placed.

---

*This document is for architecture planning only. Do not implement.*
*Revisit only when the paper trading platform is fully operational and the owner explicitly initiates a live trading phase.*
