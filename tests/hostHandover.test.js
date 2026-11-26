// The room always has a host. When the host leaves, the person in the room longest stands in at
// once; the owner (who made the room, or whom the owner handed it to by hand) gets it back on
// return. Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url) {
    const c = client(url);
    await c.open();
    return c;
}

async function room(url, ids) {
    const people = [];
    for (const id of ids) people.push(await open(url));
    people[0].send({ type: 'create-room', peerId: ids[0] });
    const created = await people[0].next('room-created');
    const joined = [];
    for (let i = 1; i < ids.length; i++) {
        people[i].send({ type: 'join', roomId: created.roomId, peerId: ids[i] });
        joined.push(await people[i].next('joined'));
    }
    return { people, created, joined };
}

describe('host migration', () => {
    let server;
    before(async () => { server = await startServer(); });
    after(() => server.proc.kill());

    it('makes the longest-present person host at once when the host leaves (a stand-in, no host token)', async () => {
        const { people: [host, first, second] } = await room(server.url, ['hm-h', 'hm-a', 'hm-b']);
        host.send({ type: 'leave' });
        const msg = await first.next('host', 1000);
        assert.equal(msg.hostPeerId, 'hm-a', 'the first to join after the host');
        assert.equal(msg.reason, 'host-left');
        assert.equal(msg.from, undefined, "not a hand-over: older apps don't say someone made them host");
        assert.equal((await second.next('host', 1000)).hostPeerId, 'hm-a');
        await wait(200);
        assert.ok(!first.inbox.some((m) => m.type === 'host-token'), 'a stand-in gets no host token');
        for (const c of [host, first, second]) c.close();
    });

    it('gives the room back to its owner when it returns (Leave then Rejoin)', async () => {
        const { people: [host, guest], created } = await room(server.url, ['hk-h', 'hk-g']);
        host.send({ type: 'leave' });
        await host.next('left');
        assert.equal((await guest.next('host')).hostPeerId, 'hk-g', 'the guest stands in');
        host.send({ type: 'create-room', roomId: created.roomId, peerId: 'hk-h', hostToken: created.hostToken });
        const back = await host.next('room-resumed');
        assert.equal(back.hostPeerId, 'hk-h');
        assert.ok(back.hostToken, 'the owner keeps a host token');
        const msg = await guest.next('host');
        assert.equal(msg.hostPeerId, 'hk-h');
        assert.equal(msg.reason, 'host-returned');
        host.close();
        guest.close();
    });

    it('gives the room back when the owner returns with a new peer id (page reload, app restart)', async () => {
        const { people: [host, guest], created } = await room(server.url, ['hr-h', 'hr-g']);
        host.close();
        assert.equal((await guest.next('host')).hostPeerId, 'hr-g');
        const reloaded = await open(server.url);
        reloaded.send({ type: 'create-room', roomId: created.roomId, peerId: 'hr-h2', hostToken: created.hostToken });
        assert.equal((await reloaded.next('room-resumed')).hostPeerId, 'hr-h2');
        const msg = await guest.next('host');
        assert.equal(msg.hostPeerId, 'hr-h2');
        assert.equal(msg.reason, 'host-returned');
        reloaded.close();
        guest.close();
    });

    it('gives the room back when the owner reclaims its own seat (join with its seat token)', async () => {
        const { people: [host, guest], created } = await room(server.url, ['hs-h', 'hs-g']);
        host.close();
        assert.equal((await guest.next('host')).hostPeerId, 'hs-g');
        const back = await open(server.url);
        back.send({ type: 'join', roomId: created.roomId, peerId: 'hs-h', rejoin: true, seatToken: created.seatToken });
        const joined = await back.next('joined');
        assert.equal(joined.hostPeerId, 'hs-h');
        assert.ok(joined.hostToken, 'host token again');
        assert.equal((await guest.next('host')).reason, 'host-returned');
        back.close();
        guest.close();
    });

    it('keeps a stand-in chain going and still returns the room to the owner', async () => {
        const { people: [host, a, b], created } = await room(server.url, ['hc-h', 'hc-a', 'hc-b']);
        host.close();
        assert.equal((await b.next('host')).hostPeerId, 'hc-a');
        a.close();
        assert.equal((await b.next('host')).hostPeerId, 'hc-b', 'the next stand-in, at once');
        const back = await open(server.url);
        back.send({ type: 'create-room', roomId: created.roomId, peerId: 'hc-h', hostToken: created.hostToken });
        await back.next('room-resumed');
        assert.equal((await b.next('host')).hostPeerId, 'hc-h');
        back.close();
        b.close();
    });

    it("doesn't give the room back when the owner handed it on by hand", async () => {
        const { people: [host, guest], created } = await room(server.url, ['ht-h', 'ht-g']);
        host.send({ type: 'transfer-host', targetPeerId: 'ht-g' });
        assert.equal((await guest.next('host')).from, 'ht-h');
        assert.equal((await host.next('host')).hostPeerId, 'ht-g');
        const token = await guest.next('host-token');
        host.send({ type: 'leave' });
        await host.next('left');
        host.send({ type: 'create-room', roomId: created.roomId, peerId: 'ht-h', hostToken: created.hostToken });
        assert.equal((await host.next('error')).code, 'resume-denied', "the old owner's token no longer works");
        // the new owner gets the same treatment: it drops, the old owner (back as a guest) stands in,
        // and the room is the new owner's again when it returns
        host.send({ type: 'join', roomId: created.roomId, peerId: 'ht-h', rejoin: true, seatToken: created.seatToken });
        assert.equal((await host.next('joined')).hostPeerId, 'ht-g');
        guest.close();
        assert.equal((await host.next('host')).hostPeerId, 'ht-h', 'stands in');
        const back = await open(server.url);
        back.send({ type: 'create-room', roomId: created.roomId, peerId: 'ht-g', hostToken: token.hostToken });
        await back.next('room-resumed');
        const msg = await host.next('host');
        assert.equal(msg.hostPeerId, 'ht-g');
        assert.equal(msg.reason, 'host-returned');
        back.close();
        host.close();
    });

    it("doesn't hand over when a guest leaves, or when the room empties", async () => {
        const { people: [host, guest] } = await room(server.url, ['hg-h', 'hg-g']);
        guest.send({ type: 'leave' });
        await host.next('peer-left');
        await wait(200);
        assert.ok(!host.inbox.some((m) => m.type === 'host' || m.type === 'host-token'));
        host.send({ type: 'leave' });
        await host.next('left');
        const probe = await open(server.url);
        probe.send({ type: 'ping' });
        await probe.next('pong');
        for (const c of [host, guest, probe]) c.close();
    });

    it('turns a hub room back into a mesh when its host leaves', async () => {
        const { people: [host, guest] } = await room(server.url, ['hh-h', 'hh-g']);
        host.send({ type: 'set-topology', topology: 'hub' });
        assert.equal((await guest.next('topology-changed')).topology, 'hub');
        host.send({ type: 'leave' });
        assert.equal((await guest.next('host')).hostPeerId, 'hh-g');
        assert.equal((await guest.next('topology-changed')).topology, 'mesh');
        host.close();
        guest.close();
    });
});

describe('host after a server restart', () => {
    it('makes the first guest back the host at once, then gives the room back to the owner', async () => {
        const env = { SIGNAL_SECRET: 'restart-test-secret-0123456789abcdef' };
        let server = await startServer(env);
        const { people, created, joined } = await room(server.url, ['rs-h', 'rs-g']);
        for (const c of people) c.close();
        server.proc.kill();
        await wait(200);
        server = await startServer(env);
        try {
            const guest = await open(server.url);
            guest.send({ type: 'join', roomId: created.roomId, peerId: 'rs-g', rejoin: true, seatToken: joined[0].seatToken });
            assert.equal((await guest.next('joined')).hostPeerId, 'rs-g', 'never a room without a host');
            const host = await open(server.url);
            host.send({ type: 'create-room', roomId: created.roomId, peerId: 'rs-h', hostToken: created.hostToken });
            assert.equal((await host.next('room-resumed')).hostPeerId, 'rs-h');
            const msg = await guest.next('host');
            assert.equal(msg.hostPeerId, 'rs-h');
            assert.equal(msg.reason, 'host-returned');
            host.close();
            guest.close();
        } finally {
            server.proc.kill();
        }
    });
});
