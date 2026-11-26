// Signaling server: rooms, joining, the size limit, relaying offers. Starts the real server.
// Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { isOriginAllowed } from '../signaling.js';
import { circlesFile } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://localhost:${PORT}`;
let server;

function client() {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        const i = waiters.findIndex((w) => w.type === msg.type);
        if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
        else inbox.push(msg);
    });
    return {
        ws,
        open: () => new Promise((resolve) => ws.once('open', resolve)),
        send: (msg) => ws.send(JSON.stringify(msg)),
        next(type, ms = 3000) {
            const i = inbox.findIndex((m) => m.type === type);
            if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
            return new Promise((resolve, reject) => {
                waiters.push({ type, resolve });
                setTimeout(() => reject(new Error(`no ${type} within ${ms} ms`)), ms);
            });
        },
        close: () => ws.close()
    };
}

async function connected(peerId) {
    const c = client();
    await c.open();
    c.peerId = peerId;
    return c;
}

describe('signaling server', () => {
    before(async () => {
        server = spawn(process.execPath, ['server.js'], { cwd: path.join(here, '..'), env: { ...process.env, PORT: String(PORT), YOUTUBE_API_KEY: '', SIGNAL_CIRCLES_FILE: circlesFile() }, stdio: 'ignore' });
        for (let i = 0; i < 50; i++) {
            try {
                const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
                if (res.status) return;
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('server did not start');
    });
    after(() => server?.kill());

    it('creates a room with a 5-digit code and lets people join it', async () => {
        const host = await connected('host-1');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        assert.match(String(roomId), /^\d{5}$/);
        const guest = await connected('guest-1');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        const joined = await guest.next('joined');
        assert.deepEqual(joined.peers, ['host-1']);
        const notice = await host.next('peer-joined');
        assert.equal(notice.peerId, 'guest-1');
        host.close();
        guest.close();
    });

    it('relays an offer to the named peer, marked with who sent it', async () => {
        const host = await connected('host-2');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('guest-2');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        await guest.next('joined');
        await host.next('peer-joined');
        host.send({ type: 'offer', targetId: 'guest-2', offer: { type: 'offer', sdp: 'x' } });
        const offer = await guest.next('offer');
        assert.equal(offer.from, 'host-2');
        assert.equal(offer.offer.sdp, 'x');
        host.close();
        guest.close();
    });

    it('rejects untargeted offer in multi-peer room', async () => {
        const host = await connected('host-mp');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest1 = await connected('guest-mp-1');
        guest1.send({ type: 'join', roomId, peerId: guest1.peerId });
        await guest1.next('joined');
        await host.next('peer-joined');
        const guest2 = await connected('guest-mp-2');
        guest2.send({ type: 'join', roomId, peerId: guest2.peerId });
        await guest2.next('joined');
        await host.next('peer-joined');
        await guest1.next('peer-joined');

        host.send({ type: 'offer', offer: { type: 'offer', sdp: 'xyz' } });
        const err = await host.next('error');
        assert.equal(err.message, 'targetId required in multi-peer rooms');

        host.close();
        guest1.close();
        guest2.close();
    });

    it('refuses an unknown room and a full room', async () => {
        const lost = await connected('lost');
        lost.send({ type: 'join', roomId: '00000', peerId: lost.peerId });
        assert.ok((await lost.next('error')).message);
        lost.close();

        const host = await connected('h3');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const others = [];
        for (let i = 0; i < 3; i++) {
            const c = await connected(`p3-${i}`);
            c.send({ type: 'join', roomId, peerId: c.peerId });
            await c.next('joined');
            others.push(c);
        }
        const fifth = await connected('p3-late');
        fifth.send({ type: 'join', roomId, peerId: fifth.peerId });
        assert.match((await fifth.next('error')).message, /full/);
        for (const c of [host, ...others, fifth]) c.close();
    });

    it('tells the room when someone leaves', async () => {
        const host = await connected('h4');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g4');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        await guest.next('joined');
        guest.send({ type: 'leave' });
        assert.equal((await host.next('peer-left')).peerId, 'g4');
        host.close();
        guest.close();
    });

    it("refuses someone claiming a peer id that's in use (S1), and keeps routing to its owner", async () => {
        const host = await connected('h5');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const victim = await connected('victim-5');
        victim.send({ type: 'join', roomId, peerId: victim.peerId });
        await victim.next('joined');
        await host.next('peer-joined');
        const thief = await connected('victim-5');
        thief.send({ type: 'join', roomId, peerId: 'victim-5' });
        assert.equal((await thief.next('error')).code, 'seat-taken');
        thief.send({ type: 'join', roomId, peerId: 'victim-5', rejoin: true, seatToken: 'v1.0123456789abcdef.9999999999.forged' });
        assert.equal((await thief.next('error')).code, 'seat-taken');
        host.send({ type: 'offer', targetId: 'victim-5', offer: { type: 'offer', sdp: 'y' } });
        assert.equal((await victim.next('offer')).offer.sdp, 'y');
        for (const c of [host, victim, thief]) c.close();
    });

    it('lets a peer reclaim its own seat with its seat token (signaling dropped)', async () => {
        const host = await connected('h6');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g6');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        const { seatToken, hostToken } = await guest.next('joined');
        assert.ok(seatToken);
        assert.equal(hostToken, undefined, 'only the host gets the host token');
        await host.next('peer-joined');
        const again = await connected('g6'); // the old socket isn't closed yet
        again.send({ type: 'join', roomId, peerId: 'g6', rejoin: true, seatToken });
        assert.deepEqual((await again.next('joined')).peers, ['h6']);
        host.send({ type: 'offer', targetId: 'g6', offer: { type: 'offer', sdp: 'z' } });
        assert.equal((await again.next('offer')).offer.sdp, 'z');
        for (const c of [host, guest, again]) c.close();
    });

    it('resumes a room only with its host token (S9), also with a new peer id', async () => {
        const host = await connected('h7');
        host.send({ type: 'create-room', peerId: host.peerId });
        const created = await host.next('room-created');
        assert.ok(created.hostToken && created.seatToken);
        const stranger = await connected('s7');
        stranger.send({ type: 'create-room', roomId: created.roomId, peerId: 's7' });
        assert.equal((await stranger.next('error')).code, 'resume-denied');
        // A host token for another room doesn't work either
        const other = await connected('h7b');
        other.send({ type: 'create-room', peerId: 'h7b' });
        const otherRoom = await other.next('room-created');
        stranger.send({ type: 'create-room', roomId: created.roomId, peerId: 's7', hostToken: otherRoom.hostToken });
        assert.equal((await stranger.next('error')).code, 'resume-denied');
        // The host after reloading the page: new peer id, same host token
        const reloaded = await connected('h7-new');
        reloaded.send({ type: 'create-room', roomId: created.roomId, peerId: 'h7-new', hostToken: created.hostToken });
        const resumed = await reloaded.next('room-resumed');
        assert.equal(resumed.roomId, created.roomId);
        assert.ok(resumed.hostToken, 'the resumed host gets a fresh host token');
        for (const c of [host, stranger, other, reloaded]) c.close();
    });

    it('gives the host its room back after Leave with only the host token (same peer id, M2)', async () => {
        // Alone: leaving closes the room; Rejoin brings it back
        const solo = await connected('h7c');
        solo.send({ type: 'create-room', peerId: 'h7c' });
        const soloRoom = await solo.next('room-created');
        solo.send({ type: 'leave' });
        await solo.next('left');
        solo.send({ type: 'create-room', roomId: soloRoom.roomId, peerId: 'h7c', hostToken: soloRoom.hostToken });
        const soloBack = await solo.next('room-resumed');
        assert.equal(soloBack.roomId, soloRoom.roomId);
        assert.equal(soloBack.hostPeerId, 'h7c');

        // With a guest still in the room: the host comes back as host
        const host = await connected('h7d');
        host.send({ type: 'create-room', peerId: 'h7d' });
        const created = await host.next('room-created');
        const guest = await connected('g7d');
        guest.send({ type: 'join', roomId: created.roomId, peerId: 'g7d' });
        await guest.next('joined');
        host.send({ type: 'leave' });
        await host.next('left');
        await guest.next('peer-left');
        // the guest stands in while the host is away (a room always has a host)
        assert.equal((await guest.next('host')).hostPeerId, 'g7d');
        host.send({ type: 'create-room', roomId: created.roomId, peerId: 'h7d', hostToken: created.hostToken });
        const back = await host.next('room-resumed');
        assert.deepEqual(back.peers, ['g7d']);
        assert.equal((await guest.next('host')).hostPeerId, 'h7d');

        // The host token is for the host's seat: it can't take over a guest who is still there
        const grab = await connected('g7d');
        grab.send({ type: 'create-room', roomId: created.roomId, peerId: 'g7d', hostToken: created.hostToken });
        assert.equal((await grab.next('error')).code, 'seat-taken');
        host.send({ type: 'offer', targetId: 'g7d', offer: { type: 'offer', sdp: 'still-guest' } });
        assert.equal((await guest.next('offer')).offer.sdp, 'still-guest');
        for (const c of [solo, host, guest, grab]) c.close();
    });

    it('lets the host hand the room to someone else, and the old host token stops working', async () => {
        const host = await connected('h7t');
        host.send({ type: 'create-room', peerId: 'h7t' });
        const created = await host.next('room-created');
        const guest = await connected('g7t');
        guest.send({ type: 'join', roomId: created.roomId, peerId: 'g7t' });
        const joined = await guest.next('joined');
        const other = await connected('o7t');
        other.send({ type: 'join', roomId: created.roomId, peerId: 'o7t' });
        await other.next('joined');

        // Only the host may do it, and only to someone who is here
        guest.send({ type: 'transfer-host', targetPeerId: 'g7t' });
        assert.equal((await guest.next('error')).code, 'not-host');
        host.send({ type: 'transfer-host', targetPeerId: 'nobody' });
        assert.equal((await host.next('error')).code, 'target-not-found');
        host.send({ type: 'transfer-host', targetPeerId: 'h7t' });
        assert.equal((await host.next('error')).code, 'target-not-found', 'not to yourself');

        host.send({ type: 'transfer-host', targetPeerId: 'g7t' });
        const token = await guest.next('host-token');
        assert.equal(token.roomId, created.roomId);
        assert.ok(token.hostToken.startsWith('v2.'));
        for (const c of [host, guest, other]) assert.deepEqual(await c.next('host'), { type: 'host', hostPeerId: 'g7t', from: 'h7t' });

        // The old host can't make anyone host any more
        host.send({ type: 'transfer-host', targetPeerId: 'o7t' });
        assert.equal((await host.next('error')).code, 'not-host');
        // ...nor take the room back with its old host token (e.g. after reloading)
        const oldBack = await connected('h7t-new');
        oldBack.send({ type: 'create-room', roomId: created.roomId, peerId: 'h7t-new', hostToken: created.hostToken });
        assert.equal((await oldBack.next('error')).code, 'resume-denied');
        // The new host's token works (it reloads the page: new peer id)
        guest.close();
        const newBack = await connected('g7t-new');
        newBack.send({ type: 'create-room', roomId: created.roomId, peerId: 'g7t-new', hostToken: token.hostToken });
        const resumed = await newBack.next('room-resumed');
        assert.equal(resumed.hostPeerId, 'g7t-new');
        assert.ok(resumed.hostToken.startsWith('v2.'), 'its fresh token keeps the generation');
        // ...and can hand it on again (back to the first host, now a guest)
        newBack.send({ type: 'transfer-host', targetPeerId: 'h7t' });
        assert.ok((await host.next('host-token')).hostToken);
        assert.equal(joined.hostPeerId, 'h7t');
        for (const c of [host, other, oldBack, newBack]) c.close();
    });

    it('answers whether a room is on this server, limited like joins (M3)', async () => {
        const host = await connected('h7e');
        host.send({ type: 'create-room', peerId: 'h7e' });
        const { roomId } = await host.next('room-created');
        const asker = await connected('q7e');
        asker.send({ type: 'find-room', roomId });
        assert.deepEqual(await asker.next('room-found'), { type: 'room-found', roomId, exists: true });
        const missing = roomId === '99999' ? '99998' : '99999';
        asker.send({ type: 'find-room', roomId: missing });
        assert.equal((await asker.next('room-found')).exists, false);
        // Asking about rooms that aren't there counts as failed joins: no faster for guessing codes
        for (let i = 0; i < 20; i++) asker.send({ type: 'find-room', roomId: missing });
        assert.equal((await asker.next('error')).code, 'rate-limited');
        for (const c of [host, asker]) c.close();
    });

    it("brings back a closed room only with a seat token for it (a stranger can't make up rooms)", async () => {
        const host = await connected('h8');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g8');
        guest.send({ type: 'join', roomId, peerId: 'g8' });
        const { seatToken } = await guest.next('joined');
        host.close();
        guest.close();
        await new Promise((r) => setTimeout(r, 300)); // the room is gone
        const stranger = await connected('s8');
        stranger.send({ type: 'join', roomId, peerId: 's8', rejoin: true });
        assert.equal((await stranger.next('error')).code, 'not-found');
        stranger.send({ type: 'join', roomId, peerId: 's8', rejoin: true, seatToken });
        assert.equal((await stranger.next('error')).code, 'not-found', "someone else's seat token doesn't work");
        const back = await connected('g8');
        back.send({ type: 'join', roomId, peerId: 'g8', rejoin: true, seatToken });
        assert.equal((await back.next('joined')).roomId, roomId);
        for (const c of [stranger, back]) c.close();
    });

    it('says who the host is (S2): to joiners, and to everyone when the host comes back with a new id', async () => {
        const host = await connected('h9');
        host.send({ type: 'create-room', peerId: 'h9' });
        const created = await host.next('room-created');
        assert.equal(created.hostPeerId, 'h9');
        const guest = await connected('g9');
        guest.send({ type: 'join', roomId: created.roomId, peerId: 'g9' });
        assert.equal((await guest.next('joined')).hostPeerId, 'h9');
        const back = await connected('h9-new');
        back.send({ type: 'create-room', roomId: created.roomId, peerId: 'h9-new', hostToken: created.hostToken });
        assert.equal((await back.next('room-resumed')).hostPeerId, 'h9-new');
        assert.equal((await guest.next('host')).hostPeerId, 'h9-new');
        const late = await connected('l9');
        late.send({ type: 'join', roomId: created.roomId, peerId: 'l9' });
        assert.equal((await late.next('joined')).hostPeerId, 'h9-new');
        for (const c of [host, guest, back, late]) c.close();
    });

    it('ignores a peer id with unexpected characters (uses its own instead)', async () => {
        const c = await connected('x');
        c.send({ type: 'create-room', peerId: '<script>'.repeat(40) });
        const { peerId } = await c.next('room-created');
        assert.match(peerId, /^[0-9a-f-]{36}$/);
        c.close();
    });

    it('serves quick picks with CORS (503 without a YouTube key)', async () => {
        const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');

        // Trusted 3RTC domain
        const resTrusted = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://3rtc.me' }
        });
        assert.equal(resTrusted.headers.get('access-control-allow-origin'), 'https://3rtc.me');
        assert.equal(resTrusted.headers.get('vary'), 'Origin');

        // Trusted Vercel preview domain
        const resPreview = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://branch-preview.vercel.app' }
        });
        assert.equal(resPreview.headers.get('access-control-allow-origin'), 'https://branch-preview.vercel.app');

        // Untrusted domain (should NOT be granted CORS)
        const resUntrusted = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://malicious-attacker.com' }
        });
        assert.equal(resUntrusted.headers.get('access-control-allow-origin'), null);
    });

    it('rate-limits repeated failed room joins to prevent room code brute-force', async () => {
        const c = await connected('scanner');
        let rateLimited = false;
        for (let i = 0; i < 16; i++) {
            c.send({ type: 'join', roomId: '99990', peerId: 'scanner' });
            const msg = await c.next('error');
            if (msg.code === 'rate-limited') {
                rateLimited = true;
                break;
            }
        }
        assert.equal(rateLimited, true, 'client was rate-limited after repeated failed joins');
        c.close();
    });

    it('rejects WebSocket connections from untrusted origins', async () => {
        await assert.rejects(
            () => new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${PORT}`, {
                    headers: { Origin: 'https://evil.com' }
                });
                ws.on('open', () => {
                    ws.close();
                    resolve();
                });
                ws.on('error', (err) => reject(err));
                ws.on('unexpected-response', (req, res) => {
                    reject(new Error(`Server responded with ${res.statusCode}`));
                });
            }),
            (err) => {
                assert.match(err.message, /403/);
                return true;
            }
        );

        // Trusted origin connects cleanly
        const trustedWs = new WebSocket(`ws://localhost:${PORT}`, {
            headers: { Origin: 'https://3rtc.me' }
        });
        await new Promise((resolve, reject) => {
            trustedWs.on('open', resolve);
            trustedWs.on('error', reject);
        });
        trustedWs.close();
    });

    it('refuses unauthenticated claim of an unoccupied host seat (H-03)', async () => {
        const host = await connected('host-hijack');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId, hostToken, seatToken: hostSeatToken } = await host.next('room-created');
        assert.ok(hostToken && hostSeatToken);

        const guest = await connected('guest-innocent');
        guest.send({ type: 'join', roomId, peerId: 'guest-innocent' });
        await guest.next('joined');

        // Host temporarily leaves / disconnects while guest remains
        host.close();
        await new Promise((r) => setTimeout(r, 50));

        // Attacker attempts to sit in the host's seat without the host's seat token
        const attacker = await connected('host-hijack');
        attacker.send({ type: 'join', roomId, peerId: 'host-hijack' });
        const err = await attacker.next('error');
        assert.equal(err.code, 'seat-taken');

        // Legitimate host reclaims seat with valid seat token
        const legitimateHost = await connected('host-hijack');
        legitimateHost.send({ type: 'join', roomId, peerId: 'host-hijack', seatToken: hostSeatToken });
        const joined = await legitimateHost.next('joined');
        assert.equal(joined.roomId, roomId);
        assert.ok(joined.hostToken, 'verified host receives host token');

        attacker.close();
        guest.close();
        legitimateHost.close();
    });

    it('rejects WebSocket handshake from unauthorized third-party origin (H-05)', async () => {
        await assert.rejects(
            new Promise((resolve, reject) => {
                const ws = new WebSocket(URL, { headers: { Origin: 'https://evil-attacker.com' } });
                ws.on('open', () => { ws.close(); resolve('opened'); });
                ws.on('error', (err) => reject(err));
            }),
            /403|unexpected server response/i
        );
    });

    it('rejects oversized WebSocket messages exceeding maxPayload (M-05)', async () => {
        const c = await connected('oversized-sender');
        const largeString = 'a'.repeat(70000); // 70 KB > 64 KB maxPayload
        const closePromise = new Promise((resolve) => {
            c.ws.on('close', (code) => {
                resolve(code);
            });
        });
        c.ws.send(JSON.stringify({ type: 'ping', data: largeString }));
        const code = await closePromise;
        assert.equal(code, 1009, 'Server closes connection with code 1009 for oversized payload');
    });

    it('serves defensive security headers on HTTP responses (L-01)', async () => {
        const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    });

    it('handles CRLF and malformed requests resiliently without crashing (M-04)', async () => {
        const res = await fetch(`http://localhost:${PORT}/api/quick-picks?foo=bar%0d%0aSet-Cookie:evil=true`);
        assert.ok(res.status === 200 || res.status === 503);
        const ping = await fetch(`http://localhost:${PORT}/api/quick-picks`);
        assert.ok(ping.status === 200 || ping.status === 503);
    });

    it('supports host switching topology between mesh and hub (M7)', async () => {
        const host = await connected('host-top');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');

        const guest1 = await connected('guest-1');
        guest1.send({ type: 'join', roomId, peerId: 'guest-1' });
        await guest1.next('joined');
        await host.next('peer-joined');

        // Host switches to hub mode
        host.send({ type: 'set-topology', topology: 'hub' });
        const hostTopo = await host.next('topology-changed');
        const guestTopo = await guest1.next('topology-changed');
        assert.equal(hostTopo.topology, 'hub');
        assert.equal(guestTopo.topology, 'hub');

        // New guest joining in hub mode only connects to host
        const guest2 = await connected('guest-2');
        guest2.send({ type: 'join', roomId, peerId: 'guest-2' });
        const guest2Joined = await guest2.next('joined');
        assert.equal(guest2Joined.topology, 'hub');
        assert.deepEqual(guest2Joined.peers, [host.peerId]); // Only sees host in hub mode!

        // Host receives peer-joined for guest2
        const hostGotJoin = await host.next('peer-joined');
        assert.equal(hostGotJoin.peerId, 'guest-2');

        // Non-host cannot switch topology
        guest1.send({ type: 'set-topology', topology: 'mesh' });
        const err = await guest1.next('error');
        assert.equal(err.code, 'not-host');

        host.close();
        guest1.close();
        guest2.close();
    });

    it('supports host dynamically setting room capacity (maxUsers)', async () => {
        const host = await connected('host-size-owner');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId, maxUsers: initialLimit } = await host.next('room-created');
        assert.ok(initialLimit >= 4);

        const guest1 = await connected('guest-sz-1');
        guest1.send({ type: 'join', roomId, peerId: 'guest-sz-1' });
        await guest1.next('joined');

        // Host dynamically raises limit to 16
        host.send({ type: 'set-room-size', maxUsers: 16 });
        const hostChanged = await host.next('room-size-changed');
        const guestChanged = await guest1.next('room-size-changed');
        assert.equal(hostChanged.maxUsers, 16);
        assert.equal(guestChanged.maxUsers, 16);

        // Non-host cannot set room capacity
        guest1.send({ type: 'set-room-size', maxUsers: 20 });
        const err = await guest1.next('error');
        assert.equal(err.code, 'not-host');

        host.close();
        guest1.close();
    });

    it('handles saved circles: creation, PIN protection, stateless tokens, and auto-awakening', async () => {
        const alice = await connected('peer-alice');
        const circleRoomId = '77889';
        const pin = '4321';

        // 1. Alice creates/reserves a circle
        alice.send({
            type: 'create-room',
            roomId: circleRoomId,
            isCircle: true,
            circleName: 'Anime Night',
            pin,
            peerId: 'peer-alice'
        });
        const created = await alice.next('room-created');
        assert.equal(created.roomId, circleRoomId);
        assert.equal(created.isCircle, true);
        assert.ok(created.circleToken);
        const token = created.circleToken;

        // 2. Stranger tries to join without PIN or token -> rejected
        const stranger = await connected('peer-stranger');
        stranger.send({ type: 'join', roomId: circleRoomId, peerId: 'peer-stranger' });
        const denied = await stranger.next('error');
        assert.equal(denied.code, 'circle-pin-required');
        stranger.close();

        // 3. Bob joins with PIN
        const bob = await connected('peer-bob');
        bob.send({ type: 'join', roomId: circleRoomId, pin, peerId: 'peer-bob' });
        const bobJoined = await bob.next('joined');
        assert.equal(bobJoined.roomId, circleRoomId);
        assert.equal(bobJoined.isCircle, true);
        assert.ok(bobJoined.circleToken);

        // 4. Charlie connects using create-room (one-click circle connect) with token
        const charlie = await connected('peer-charlie');
        charlie.send({
            type: 'create-room',
            roomId: circleRoomId,
            isCircle: true,
            circleToken: token,
            peerId: 'peer-charlie'
        });
        const charlieJoined = await charlie.next('joined');
        assert.equal(charlieJoined.roomId, circleRoomId);
        assert.equal(charlieJoined.isCircle, true);

        // 5. Everyone leaves -> circle room closes (empty)
        alice.close();
        bob.close();
        charlie.close();

        await new Promise((r) => setTimeout(r, 100));

        // 6. Later, Bob connects using his circle token -> awakens the circle!
        const bobReturn = await connected('peer-bob-return');
        bobReturn.send({
            type: 'create-room',
            roomId: circleRoomId,
            isCircle: true,
            circleToken: bobJoined.circleToken,
            peerId: 'peer-bob-return'
        });
        const awakened = await bobReturn.next('room-created');
        assert.equal(awakened.roomId, circleRoomId);
        assert.equal(awakened.isCircle, true);
        assert.ok(awakened.circleToken);

        bobReturn.close();
    });
});

describe('isOriginAllowed (H-05)', () => {
    it('allows same-origin, local development, and trusted domains', () => {
        assert.equal(isOriginAllowed(undefined), true);
        assert.equal(isOriginAllowed('http://localhost:5173'), true);
        assert.equal(isOriginAllowed('http://127.0.0.1:8080'), true);
        assert.equal(isOriginAllowed('https://3rtc.me'), true);
        assert.equal(isOriginAllowed('https://dev.3rtc.me'), true);
    });

    it('rejects malicious external origins', () => {
        assert.equal(isOriginAllowed('https://attacker.com'), false);
        assert.equal(isOriginAllowed('https://evil-3rtc.me.fake.com'), false);
        assert.equal(isOriginAllowed('javascript:void(0)'), false);
    });
});

