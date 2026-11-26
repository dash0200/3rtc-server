/**
 * In-memory rate limiting and brute-force protection for 3RTC signaling server.
 * Protects room creation against pool exhaustion (H-02) and room joining against
 * 5-digit PIN enumeration / brute-force scanning (H-01).
 */

export function createRateLimiter({
  maxCreatesPerWindow = Number(process.env.RATE_LIMIT_CREATE_ROOMS) || 100,
  createWindowMs = 10 * 60 * 1000,    // 10 minutes
  maxJoinsPerSec = Number(process.env.RATE_LIMIT_JOINS_PER_SEC) || 100,
  joinWindowMs = 1000,                // 1 second
  maxInvalidJoins = Number(process.env.RATE_LIMIT_INVALID_JOINS) || 30,
  invalidJoinWindowMs = 60 * 1000,    // 1 minute
  banDurationMs = 5 * 60 * 1000       // 5 minutes
} = {}) {
  // Map<ip, number[]>: timestamps of room creations
  const creates = new Map();
  // Map<ip, number[]>: timestamps of join attempts
  const joins = new Map();
  // Map<ip, number[]>: timestamps of invalid room joins
  const invalidJoins = new Map();
  // Map<ip, number>: timestamp until which join attempts are banned
  const bans = new Map();

  function pruneTimestamps(list, windowMs, now) {
    const cutoff = now - windowMs;
    return list.filter((t) => t > cutoff);
  }

  return {
    /**
     * Check if a room creation from IP is permitted.
     * Returns true if allowed, false if rate limited.
     */
    checkCreateRoom(ip, now = Date.now()) {
      if (!ip) return true;
      const history = pruneTimestamps(creates.get(ip) || [], createWindowMs, now);
      if (history.length >= maxCreatesPerWindow) {
        creates.set(ip, history);
        return false;
      }
      history.push(now);
      creates.set(ip, history);
      return true;
    },

    /**
     * Check if joining from IP is currently banned due to excessive invalid attempts.
     */
    isJoinBanned(ip, now = Date.now()) {
      if (!ip) return { banned: false };
      const bannedUntil = bans.get(ip);
      if (bannedUntil && bannedUntil > now) {
        return { banned: true, retryAfterMs: bannedUntil - now };
      }
      if (bannedUntil) {
        bans.delete(ip);
      }
      return { banned: false };
    },

    /**
     * Check if instantaneous join request rate is within limits.
     */
    checkJoinRate(ip, now = Date.now()) {
      if (!ip) return true;
      const history = pruneTimestamps(joins.get(ip) || [], joinWindowMs, now);
      if (history.length >= maxJoinsPerSec) {
        joins.set(ip, history);
        return false;
      }
      history.push(now);
      joins.set(ip, history);
      return true;
    },

    /**
     * Record a failed room join attempt (e.g. non-existent room).
     * If threshold exceeded, bans IP from joining for banDurationMs.
     */
    recordInvalidJoin(ip, now = Date.now()) {
      if (!ip) return;
      const history = pruneTimestamps(invalidJoins.get(ip) || [], invalidJoinWindowMs, now);
      history.push(now);
      invalidJoins.set(ip, history);

      if (history.length >= maxInvalidJoins) {
        bans.set(ip, now + banDurationMs);
        invalidJoins.delete(ip);
      }
    },

    /**
     * Clear invalid join tracking when a peer successfully joins a room.
     */
    recordSuccessfulJoin(ip) {
      if (!ip) return;
      invalidJoins.delete(ip);
    },

    /**
     * Reset all rate limiting state (useful for test suites).
     */
    reset() {
      creates.clear();
      joins.clear();
      invalidJoins.clear();
      bans.clear();
    },

    /**
     * Clean up expired entries across all maps to avoid memory growth.
     */
    cleanUp(now = Date.now()) {
      for (const [ip, ts] of creates.entries()) {
        const remaining = pruneTimestamps(ts, createWindowMs, now);
        if (remaining.length === 0) creates.delete(ip);
        else creates.set(ip, remaining);
      }
      for (const [ip, ts] of joins.entries()) {
        const remaining = pruneTimestamps(ts, joinWindowMs, now);
        if (remaining.length === 0) joins.delete(ip);
        else joins.set(ip, remaining);
      }
      for (const [ip, ts] of invalidJoins.entries()) {
        const remaining = pruneTimestamps(ts, invalidJoinWindowMs, now);
        if (remaining.length === 0) invalidJoins.delete(ip);
        else invalidJoins.set(ip, remaining);
      }
      for (const [ip, until] of bans.entries()) {
        if (until <= now) bans.delete(ip);
      }
    }
  };
}
