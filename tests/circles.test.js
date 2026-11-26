// Hangout Circles across two servers that share only their secret (as Google and Oracle do).
// Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { circlesFile, client, startServer } from './helpers.js';

const SECRET = 'the-same-secret-on-both-servers-0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let a;
let b;
let open = [];
let code = 41000;

async function peer(server) {
    const c = client(server.url);
    await c.open();
    open.push(c);
    return c;
}
const nextCode = () => String(code++);
const card = (roomId, peerId, more = {}) => ({ type: 'create-room', roomId, peerId, isCircle: true, ...more });

/** Makes a circle on `server` and leaves it empty; what its maker keeps. */
async function emptyCircle(server, roomId, pin) {
    const c = await peer(server);
    c.send(card(roomId, 'maker', pin ? { pin } : {}));
    const made = await c.next('room-created');
    c.close();
    await wait(80);
    return made;
}

describe('hangout circles on two servers', () => {
    before(async () => {
        a = await startServer({ SIGNAL_SECRET: SECRET });
        b = await startServer({ SIGNAL_SECRET: SECRET });
    });
    after(() => {
        for (const c of open) c.close();
        a.proc.kill();
        b.proc.kill();
    });

    it('only the server where people are says the circle is there', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        const asker = await peer(a);
        asker.send({ type: 'find-room', roomId: id });
        assert.deepEqual(await asker.next('room-found'), { type: 'room-found', roomId: id, exists: false, reserved: true });

        const live = await peer(a);
        live.send(card(id, 'p1', { circleToken: made.circleToken }));
        await live.next('room-created');
        asker.send({ type: 'find-room', roomId: id });
        assert.deepEqual(await asker.next('room-found'),
            { type: 'room-found', roomId: id, exists: true, isCircle: true, reserved: true });
    });

    it('a server that never saw a circle learns it, PIN included, from its grant', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        assert.ok(made.circleGrant.startsWith('v2.circle.'));

        const member = await peer(b);
        member.send({ type: 'join', roomId: id, peerId: 'm1', circleGrant: made.circleGrant });
        const back = await member.next('room-created');
        assert.equal(back.isCircle, true);
        assert.ok(back.circleGrant);

        for (const pin of [undefined, '0000']) {
            const stranger = await peer(b);
            stranger.send({ type: 'join', roomId: id, peerId: 's1', ...(pin ? { pin } : {}) });
            assert.equal((await stranger.next('error')).code, 'circle-pin-required');
        }
        const friend = await peer(b);
        friend.send({ type: 'join', roomId: id, peerId: 'f1', pin: '7744' });
        const joined = await friend.next('joined');
        assert.deepEqual(joined.peers, ['m1']);
        assert.ok(joined.circleToken, 'once the PIN was typed, plain circle tokens work here too');
        const old = await peer(b);
        old.send(card(id, 'o1', { circleToken: made.circleToken }));
        assert.equal((await old.next('joined')).peers.length, 2);
    });

    it('a grant for another circle, or a made-up one, does not open a circle', async () => {
        const id = nextCode();
        const other = await emptyCircle(a, nextCode(), '7744');
        await emptyCircle(b, id, '1234');
        for (const circleGrant of [other.circleGrant, 'v2.circle.1.9999999999.AAAAAAAAAAAAAAAAAAAAAA.sig', 5]) {
            const c = await peer(b);
            c.send({ type: 'join', roomId: id, peerId: 'x', circleGrant });
            assert.equal((await c.next('error')).code, 'circle-pin-required');
        }
    });

    it('an earlier circle wins over someone who took its code on the other server', async () => {
        const id = nextCode();
        const real = await emptyCircle(a, id, '7744');
        await wait(5);
        const squatter = await emptyCircle(b, id, '0000');

        const member = await peer(b);
        member.send(card(id, 'm1', { circleGrant: real.circleGrant }));
        await member.next('room-created');
        const late = await peer(b);
        late.send(card(id, 's1', { pin: '0000', circleGrant: squatter.circleGrant }));
        assert.equal((await late.next('error')).code, 'circle-pin-required');
        const onA = await peer(a);
        onA.send(card(id, 's1', { circleGrant: squatter.circleGrant }));
        assert.equal((await onA.next('error')).code, 'circle-pin-required');
    });

    it('a circle token with the wrong or no PIN cannot claim the code on the other server', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        const c = await peer(b);
        c.send(card(id, 'p', { circleToken: made.circleToken }));
        assert.equal((await c.next('error')).code, 'circle-pin-required');
        c.send(card(id, 'p', { circleToken: made.circleToken, pin: '7744' }));
        await c.next('room-created');
    });

    it('a PIN circle that fails over keeps its PIN and its seats (with and without grants)', async () => {
        for (const withGrant of [true, false]) {
            const id = nextCode();
            const host = await peer(a);
            host.send(card(id, 'host', { pin: '7744' }));
            const made = await host.next('room-created');
            const guest = await peer(a);
            guest.send({ type: 'join', roomId: id, peerId: 'guest', pin: '7744' });
            const seat = await guest.next('joined');

            const host2 = await peer(b);
            host2.send(card(id, 'host', {
                hostToken: made.hostToken, seatToken: made.seatToken, circleToken: made.circleToken,
                ...(withGrant ? { circleGrant: made.circleGrant } : {})
            }));
            assert.equal((await host2.next('room-resumed')).hostPeerId, 'host');
            const guest2 = await peer(b);
            guest2.send({ type: 'join', roomId: id, peerId: 'guest', rejoin: true, seatToken: seat.seatToken });
            assert.deepEqual((await guest2.next('joined')).peers, ['host']);

            const stranger = await peer(b);
            stranger.send({ type: 'join', roomId: id, peerId: 's' });
            assert.equal((await stranger.next('error')).code, 'circle-pin-required');
            stranger.send({ type: 'join', roomId: id, peerId: 's', pin: '7744' });
            assert.equal((await stranger.next('joined')).peers.length, 2);
        }
    });

    it('two people waking a circle at once are in one room', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        const [x, y] = [await peer(a), await peer(a)];
        x.send({ type: 'join', roomId: id, peerId: 'x', circleGrant: made.circleGrant });
        y.send(card(id, 'y', { pin: '7744' }));
        await x.next('room-created');
        assert.deepEqual((await y.next('joined')).peers, ['x']);
    });

    it('joining an empty circle opens it, with the joiner as host', async () => {
        const id = nextCode();
        await emptyCircle(a, id);
        const c = await peer(a);
        c.send({ type: 'join', roomId: id, peerId: 'c' });
        const opened = await c.next('room-created');
        assert.equal(opened.hostPeerId, 'c');
        assert.ok(opened.hostToken);
        const d = await peer(a);
        d.send({ type: 'join', roomId: id, peerId: 'd' });
        assert.deepEqual((await d.next('joined')).peers, ['c']);
    });

    it('a guest reconnecting with its seat token needs no PIN', async () => {
        const id = nextCode();
        const host = await peer(a);
        host.send(card(id, 'host', { pin: '7744' }));
        await host.next('room-created');
        const guest = await peer(a);
        guest.send({ type: 'join', roomId: id, peerId: 'guest', pin: '7744' });
        const seat = await guest.next('joined');
        guest.close();
        await wait(80);
        const back = await peer(a);
        back.send({ type: 'join', roomId: id, peerId: 'guest', rejoin: true, seatToken: seat.seatToken });
        assert.deepEqual((await back.next('joined')).peers, ['host']);
        const fake = await peer(a);
        fake.send({ type: 'join', roomId: id, peerId: 'other', rejoin: true, seatToken: seat.seatToken });
        assert.equal((await fake.next('error')).code, 'circle-pin-required');
    });

    it('the PIN does not give away the host seat or one in use', async () => {
        const id = nextCode();
        const host = await peer(a);
        host.send(card(id, 'host', { pin: '7744' }));
        await host.next('room-created');
        const guest = await peer(a);
        guest.send({ type: 'join', roomId: id, peerId: 'guest', pin: '7744' });
        await guest.next('joined');
        for (const peerId of ['host', 'guest']) {
            const thief = await peer(a);
            thief.send(card(id, peerId, { pin: '7744' }));
            assert.equal((await thief.next('error')).code, 'seat-taken');
        }
    });

    it('its maker can come back after leaving, while others stayed', async () => {
        const id = nextCode();
        const host = await peer(a);
        host.send(card(id, 'host', { pin: '7744' }));
        const made = await host.next('room-created');
        const guest = await peer(a);
        guest.send({ type: 'join', roomId: id, peerId: 'guest', pin: '7744' });
        await guest.next('joined');
        host.send({ type: 'leave' });
        await host.next('left');

        // the saved card (no seat token any more): back in, as a guest
        host.send(card(id, 'host', { pin: '7744' }));
        const joined = await host.next('joined');
        assert.equal(joined.hostPeerId, 'guest');
        assert.equal(joined.hostToken, undefined);
        // Rejoin (it kept the host token): host again
        host.send({ type: 'leave' });
        await host.next('left');
        host.send(card(id, 'host', { hostToken: made.hostToken, pin: '7744' }));
        assert.equal((await host.next('room-resumed')).hostPeerId, 'host');
    });

    it('an old host token does not block its holder from the circle: in as a guest', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        const other = await peer(a);
        other.send(card(id, 'other', { pin: '7744' }));
        await other.next('room-created');
        const maker = await peer(a);
        maker.send(card(id, 'maker', { hostToken: made.hostToken, circleGrant: made.circleGrant }));
        assert.equal((await maker.next('joined')).hostPeerId, 'other');
    });

    it('circles survive a restart, a learned one with its PIN', async () => {
        const id = nextCode();
        const file = circlesFile();
        const made = await emptyCircle(a, id, '7744');
        let s = await startServer({ SIGNAL_SECRET: SECRET, SIGNAL_CIRCLES_FILE: file });
        const m = await peer(s);
        m.send({ type: 'join', roomId: id, peerId: 'm', circleGrant: made.circleGrant });
        await m.next('room-created');
        await wait(800); // written half a second later
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[id].pinHash, 'grant');
        s.proc.kill();
        s = await startServer({ SIGNAL_SECRET: SECRET, SIGNAL_CIRCLES_FILE: file });
        const c = await peer(s);
        c.send({ type: 'join', roomId: id, peerId: 'c' });
        assert.equal((await c.next('error')).code, 'circle-pin-required');
        c.send({ type: 'join', roomId: id, peerId: 'c', pin: '7744' });
        await c.next('room-created');
        s.proc.kill();
    });

    it('tells how many people are in a circle only to someone who may enter it', async () => {
        const id = nextCode();
        const made = await emptyCircle(a, id, '7744');
        const asker = await peer(a);
        const find = async (more = {}) => {
            asker.send({ type: 'find-room', roomId: id, ...more });
            return (await asker.next('room-found')).people;
        };
        assert.equal(await find({ circleGrant: made.circleGrant }), undefined, 'nobody in it');
        for (const n of [1, 2]) {
            const p = await peer(a);
            p.send(card(id, `p${n}`, { pin: '7744' }));
            await p.next(n === 1 ? 'room-created' : 'joined');
            assert.equal(await find({ circleGrant: made.circleGrant }), n);
            assert.equal(await find({ circleToken: made.circleToken }), n);
        }
        assert.equal(await find(), undefined);
        assert.equal(await find({ pin: '7744' }), undefined, 'not a way to try PINs');
        const other = await emptyCircle(a, nextCode(), '7744');
        assert.equal(await find({ circleGrant: other.circleGrant, circleToken: other.circleToken }), undefined);

        const open = nextCode();
        const p = await peer(a);
        p.send(card(open, 'p'));
        await p.next('room-created');
        asker.send({ type: 'find-room', roomId: open });
        assert.equal((await asker.next('room-found')).people, 1, 'no PIN: anyone may enter');
        const plain = await peer(a);
        plain.send({ type: 'create-room', peerId: 'x' });
        const { roomId } = await plain.next('room-created');
        asker.send({ type: 'find-room', roomId });
        assert.equal((await asker.next('room-found')).people, undefined, 'not a circle');
    });

    it('guessing PINs gets an address banned for a while', async () => {
        const s = await startServer({ SIGNAL_SECRET: SECRET, RATE_LIMIT_INVALID_JOINS: '5' });
        const id = nextCode();
        await emptyCircle(s, id, '7744');
        const c = await peer(s);
        for (let i = 0; i < 5; i++) {
            c.send(card(id, 'g', { pin: `000${i}` }));
            assert.equal((await c.next('error')).code, 'circle-pin-required');
        }
        c.send(card(id, 'g', { pin: '7744' }));
        assert.equal((await c.next('error')).code, 'rate-limited');
        s.proc.kill();
    });
});
