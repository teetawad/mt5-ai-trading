import { AssetClass } from '../db/types';

/** Phase 26 supported crypto PAPER trading symbols. Alpaca crypto-pair
 * convention ("BTC/USD") — matches the existing Alpaca stock symbol style
 * this codebase already follows for US stocks. */
export const SUPPORTED_CRYPTO_SYMBOLS = ['BTC/USD', 'ETH/USD'] as const;
export const SUPPORTED_CRYPTO_PATTERN = /^(BTC|ETH)\/USD$/;

export function isCryptoSymbol(symbol: string): boolean {
  return SUPPORTED_CRYPTO_PATTERN.test(symbol);
}

/** Derived from the symbol format, never accepted as user input — avoids a
 * caller spoofing a stock proposal as CRYPTO (or vice versa) to bypass
 * market-specific risk rules. */
export function assetClassForSymbol(symbol: string): AssetClass {
  return isCryptoSymbol(symbol) ? 'CRYPTO' : 'STOCK';
}
