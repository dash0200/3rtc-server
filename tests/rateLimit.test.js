import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../rateLimit.js';

describe('createRateLimiter', () => {
  it('allows room creations up to the limit and blocks excess', () => {
    const limiter = createRateLimiter({ maxCreatesPerWindow: 3, createWindowMs: 1000 });
    const ip = '1.2.3.4';
    assert.equal(limiter.checkCreateRoom(ip), true);
    assert.equal(limiter.checkCreateRoom(ip), true);
    assert.equal(limiter.checkCreateRoom(ip), true);
    assert.equal(limiter.checkCreateRoom(ip), false, '4th creation should be blocked');

    // Different IP should still be allowed
    assert.equal(limiter.checkCreateRoom('5.6.7.8'), true);
  });

  it('rate limits excessive instantaneous join attempts', () => {
    const limiter = createRateLimiter({ maxJoinsPerSec: 2, joinWindowMs: 1000 });
    const ip = '10.0.0.1';
    assert.equal(limiter.checkJoinRate(ip), true);
    assert.equal(limiter.checkJoinRate(ip), true);
    assert.equal(limiter.checkJoinRate(ip), false, '3rd join within 1s should be throttled');
  });

  it('bans IP after excessive invalid room joins (brute force PIN sweep protection)', () => {
    const limiter = createRateLimiter({
      maxInvalidJoins: 3,
      invalidJoinWindowMs: 10000,
      banDurationMs: 50000
    });
    const ip = '192.168.1.100';
    assert.equal(limiter.isJoinBanned(ip).banned, false);

    limiter.recordInvalidJoin(ip);
    assert.equal(limiter.isJoinBanned(ip).banned, false);
    limiter.recordInvalidJoin(ip);
    assert.equal(limiter.isJoinBanned(ip).banned, false);
    limiter.recordInvalidJoin(ip); // Reaches 3 failures

    const ban = limiter.isJoinBanned(ip);
    assert.equal(ban.banned, true);
    assert.ok(ban.retryAfterMs > 0);
  });

  it('resets invalid joins on successful room join', () => {
    const limiter = createRateLimiter({ maxInvalidJoins: 3 });
    const ip = '192.168.1.50';
    limiter.recordInvalidJoin(ip);
    limiter.recordInvalidJoin(ip);
    limiter.recordSuccessfulJoin(ip);

    // Should require 3 more failed attempts to ban
    limiter.recordInvalidJoin(ip);
    assert.equal(limiter.isJoinBanned(ip).banned, false);
  });

  it('cleans up expired records', () => {
    const limiter = createRateLimiter({
      createWindowMs: 100,
      joinWindowMs: 100,
      invalidJoinWindowMs: 100,
      banDurationMs: 100
    });
    const ip = '127.0.0.1';
    limiter.checkCreateRoom(ip, 1000);
    limiter.recordInvalidJoin(ip, 1000);
    limiter.cleanUp(2000); // 1 second later
    assert.equal(limiter.checkCreateRoom(ip, 2000), true);
  });
});
