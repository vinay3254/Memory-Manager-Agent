// ============================================================
// src/utils/ttl.ts
// Shared helper for parsing TTL duration strings.
// ============================================================

export function parseTTL(ttl: string): number | undefined {
  const match = ttl.match(/^(\d+)([smhdwy])$/i);
  if (!match) return undefined;
  const val = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const ms = 1000;
  switch (unit) {
    case "s": return val * ms;
    case "m": return val * ms * 60;
    case "h": return val * ms * 60 * 60;
    case "d": return val * ms * 60 * 60 * 24;
    case "w": return val * ms * 60 * 60 * 24 * 7;
    case "y": return val * ms * 60 * 60 * 24 * 365;
    default: return undefined;
  }
}
