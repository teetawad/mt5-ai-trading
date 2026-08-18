// Unique per-plan MT5 order comment (spec section 4: "Every submitted AI
// pending order must have a unique execution key... encode a short unique
// identifier into the MT5 order comment"). This broker rejects any order
// comment over ~28 characters (see mt5-entry-plan-watcher.ts's own
// planCommentRef), so this stays short: "AIV3" + 12 hex chars = 16 chars.
//
// Deliberately its own module (not re-exported from trading-ai-service.ts):
// both trading-ai-service.ts and ai-trade-plan-watcher.ts need it, and those
// two already depend on each other's other exports, so a shared leaf module
// avoids a circular import between them.
export function planComment(planId: unknown): string {
  return `AIV3${String(planId).replace(/-/g, '').slice(0, 12)}`;
}
