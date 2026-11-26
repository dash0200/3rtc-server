// Seat and host tokens (seats.js): who may take a seat or get a room back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeats, isValidPeerId, newEpoch, TOKEN_TTL_MS, CIRCLE_TOKEN_TTL_MS, hashCirclePin } from '../seats.js';

const seats = createSeats('test-secret');
const epoch = newEpoch();

test('a seat token works for its own room, room instance and peer id only', () => {
    const t = seats.seatToken('12345', epoch, 'peer-a');
    assert.equal(seats.checkSeat(t, '12345', 'peer-a'), epoch);
    assert.equal(seats.checkSeat(t, '12346', 'peer-a'), null);
    assert.equal(seats.checkSeat(t, '12345', 'peer-b'), null);
    assert.equal(seats.checkHost(t, '12345'), null, 'a seat token is not a host token');
});

test('a host token works for its room with any peer id', () => {
    const t = seats.hostToken('12345', epoch);
    assert.equal(seats.checkHost(t, '12345'), epoch);
    assert.equal(seats.checkHost(t, '54321'), null);
    assert.equal(seats.checkSeat(t, '12345', ''), null);
});

test('tokens expire, and tampered or foreign tokens fail', () => {
    const now = Date.now();
    const t = seats.hostToken('12345', epoch, 0, now);
    assert.equal(seats.checkHost(t, '12345', now + TOKEN_TTL_MS + 2000), null);
    const [v, e, exp, sig] = t.split('.');
    assert.equal(seats.checkHost([v, e, String(Number(exp) + 9999), sig].join('.'), '12345'), null, 'a longer expiry breaks it');
    assert.equal(seats.checkHost([v, newEpoch(), exp, sig].join('.'), '12345'), null, 'another room instance breaks it');
    assert.equal(createSeats('other-secret').checkHost(t, '12345'), null, 'another server secret');
    for (const junk of [undefined, null, 42, '', 'v1', 'x'.repeat(500)]) assert.equal(seats.checkHost(junk, '12345'), null);
});

test('host tokens carry the host generation (a handed-over room): v1 form for generation 0', () => {
    const first = seats.hostToken('12345', epoch);
    assert.ok(first.startsWith('v1.'), 'generation 0 keeps the original form');
    assert.deepEqual(seats.checkHostGen(first, '12345'), { epoch, gen: 0 });
    const third = seats.hostToken('12345', epoch, 2);
    assert.ok(third.startsWith('v2.'));
    assert.deepEqual(seats.checkHostGen(third, '12345'), { epoch, gen: 2 });
    assert.equal(seats.checkHost(third, '12345'), epoch);
    assert.equal(seats.checkHostGen(third, '54321'), null, 'another room');
    const [v, e, , exp, sig] = third.split('.');
    assert.equal(seats.checkHostGen([v, e, '9', exp, sig].join('.'), '12345'), null, 'a made-up generation breaks it');
    assert.equal(seats.checkSeat(third, '12345', 'g2'), null, 'not a seat token');
});

test('peer ids: short safe text only', () => {
    assert.ok(isValidPeerId(crypto.randomUUID()));
    for (const bad of ['', 'a b', '<x>', 'x'.repeat(65), 7, null]) assert.equal(isValidPeerId(bad), false);
});

test('circle tokens: stateless verification, PIN protection, and expiry', () => {
    const roomId = '48291';
    const pin = '7744';
    const pinHash = hashCirclePin(roomId, pin);
    assert.equal(typeof pinHash, 'string');
    assert.equal(pinHash.length, 16);
    assert.equal(hashCirclePin(roomId, ''), 'public');
    assert.equal(hashCirclePin(roomId, null), 'public');

    const now = Date.now();
    const token = seats.circleToken(roomId, pinHash, now);
    assert.ok(token.startsWith('v1.circle.'));
    assert.equal(seats.checkCircle(token, roomId, pinHash, now), true);

    // Wrong room
    assert.equal(seats.checkCircle(token, '48292', pinHash, now), false);

    // Wrong PIN hash
    const wrongPinHash = hashCirclePin(roomId, '9999');
    assert.equal(seats.checkCircle(token, roomId, wrongPinHash, now), false);

    // Expired token (after 60 days)
    assert.equal(seats.checkCircle(token, roomId, pinHash, now + CIRCLE_TOKEN_TTL_MS + 5000), false);

    // Tampered token
    const [v, tag, exp, sig] = token.split('.');
    assert.equal(seats.checkCircle([v, tag, String(Number(exp) + 1000), sig].join('.'), roomId, pinHash, now), false);
    assert.equal(seats.checkCircle([v, tag, exp, 'bad' + sig.slice(3)].join('.'), roomId, pinHash, now), false);

    // Different server secret
    assert.equal(createSeats('other-secret').checkCircle(token, roomId, pinHash, now), false);
});
