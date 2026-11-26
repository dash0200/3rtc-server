// Abuse limits (ABUSE_LIMITS in signaling.js): a real room never meets them; flooding does.
// Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createByteBucket } from '../signaling.js';
import { startServer, client } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// An offer about the size real ones are (Chrome with voice, video and data: 5–10 KB)
const sdp = (n) => `v=0\r\n${'a=x-line-of-a-real-sized-session-description\r\n'.repeat(Math.ceil(n / 46))}`;
const candidate = (i) => ({
    candidate: `candidate:${i} 1 udp 2122260223 192.168.1.${i} 5${i}000 typ host generation 0 ufrag abcd network-id 1`,
    sdpMid: '0',
    sdpMLineIndex: 0
});

describe('createByteBucket', () => {
    it('allows a burst, then refills at its rate', () => {
        const b = createByteBucket(100, 300, 0);
        assert.equal(b.take(300, 0), true);
        assert.equal(b.take(1, 0), false);
        assert.equal(b.take(100, 1000), true, 'a second later 100 more');
        assert.equal(b.take(1, 1000), false);
        assert.equal(b.take(300, 60_000), true, 'never more than the burst');
        assert.equal(b.take(1, 60_000), false);
    });
});

describe('abuse limits: a real room is untouched by the defaults', () => {
    let server;
    before(async () => { server = await startServer(); });
    after(() => server.proc.kill());

    it('four people join and connect (offers, answers, candidates, a restart) with no error', async () => {
        const people = [];
        for (let i = 0; i < 4; i++) {
            const c = client(server.url);
            await c.open();
            people.push(c);
        }
        const [host, ...guests] = people;
        const ids = ['real-0', 'real-1', 'real-2', 'real-3'];
        host.send({ type: 'create-room', peerId: ids[0] });
        const { roomId } = await host.next('room-created');
        for (const [i, g] of guests.entries()) {
            g.send({ type: 'join', roomId, peerId: ids[i + 1] });
            await g.next('joined');
        }
        // Everyone sets up a connection to everyone, twice (the second as an ICE restart a second
        // later), as fast as a real app does: per connection an offer or answer and 8 candidates
        let relayed = 0;
        for (let round = 0; round < 2; round++) {
            if (round) await wait(1100);
            for (let a = 0; a < 4; a++) {
                for (let b = a + 1; b < 4; b++) {
                    people[a].send({ type: 'offer', targetId: ids[b], offer: { type: 'offer', sdp: sdp(9000) }, iceRestart: round === 1 });
                    people[b].send({ type: 'answer', targetId: ids[a], answer: { type: 'answer', sdp: sdp(9000) } });
                    for (let k = 0; k < 8; k++) {
                        people[a].send({ type: 'ice-candidate', targetId: ids[b], candidate: candidate(k) });
                        people[b].send({ type: 'ice-candidate', targetId: ids[a], candidate: candidate(k) });
                    }
                    relayed += 2 + 16;
                }
            }
        }
        await wait(500);
        const errors = people.flatMap((p) => p.inbox.filter((m) => m.type === 'error'));
        assert.deepEqual(errors, [], 'no limit was hit');
        const received = people.reduce((n, p) => n + p.inbox.filter((m) => ['offer', 'answer', 'ice-candidate'].includes(m.type)).length, 0);
        assert.equal(received, relayed, 'every signal arrived');
        for (const p of people) p.close();
    });
});

describe('abuse limits: flooding is stopped', () => {
    let server;
    before(async () => {
        server = await startServer({
            SIGNAL_MAX_CONNECTIONS_PER_IP: '3',
            SIGNAL_BYTES_PER_SEC: '20000',
            SIGNAL_BURST_BYTES: '40000',
            SIGNAL_MAX_RELAY_BYTES: '16000'
        });
    });
    after(() => server.proc.kill());

    it('refuses more connections from one address than allowed, and frees the slot on close', async () => {
        const open = [];
        for (let i = 0; i < 3; i++) {
            const c = client(server.url);
            await c.open();
            open.push(c);
        }
        const extra = client(server.url);
        const refused = await extra.open().then(() => null, (e) => e.status);
        assert.equal(refused, 503, 'the fourth is turned away before it opens');
        open.pop().close();
        await wait(200);
        const again = client(server.url);
        await again.open();
        for (const c of [...open, again]) c.close();
        await wait(200);
    });

    it('refuses an offer bigger than a real one could be', async () => {
        const host = client(server.url);
        const guest = client(server.url);
        await host.open();
        await guest.open();
        host.send({ type: 'create-room', peerId: 'big-host' });
        const { roomId } = await host.next('room-created');
        guest.send({ type: 'join', roomId, peerId: 'big-guest' });
        await guest.next('joined');
        host.send({ type: 'offer', targetId: 'big-guest', offer: { type: 'offer', sdp: sdp(20000) } });
        const err = await host.next('error');
        assert.equal(err.message, 'Signal too large');
        host.close();
        guest.close();
        await wait(200);
    });

    it('stops a connection that sends more bytes than its budget, then lets it go on', async () => {
        const c = client(server.url);
        await c.open();
        const filler = 'x'.repeat(9000);
        for (let i = 0; i < 6; i++) c.send({ type: 'ping', filler }); // ~54 KB > 40 KB burst
        const err = await c.next('error');
        assert.equal(err.code, 'rate-limited');
        assert.match(err.message, /Data rate/);
        await wait(1200); // refilled by 20 KB/s
        c.inbox.length = 0;
        c.send({ type: 'ping' });
        await c.next('pong');
        c.close();
        await wait(200);
    });

    it("doesn't echo a huge message type back", async () => {
        const c = client(server.url);
        await c.open();
        c.send({ type: 'z'.repeat(5000) });
        const err = await c.next('error');
        assert.ok(err.message.length < 100, `short error (${err.message.length} chars)`);
        c.close();
    });
});
