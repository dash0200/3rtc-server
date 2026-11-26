// Shared by the server tests that start their own server.js with special settings.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A file of its own for a test server's reserved circles (never the one next to server.js). */
export const circlesFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), '3rtc-test-')), 'circles.json');

/** Starts server.js on a random port with these environment settings. */
export async function startServer(env = {}) {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, ['server.js'], {
        cwd: path.join(here, '..'),
        env: { ...process.env, PORT: String(port), YOUTUBE_API_KEY: '', SIGNAL_CIRCLES_FILE: circlesFile(), ...env },
        stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
        try {
            const res = await fetch(`http://localhost:${port}/api/quick-picks`);
            if (res.status) return { proc, url: `ws://localhost:${port}` };
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill();
    throw new Error('server did not start');
}

export function client(url) {
    const ws = new WebSocket(url);
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
        inbox,
        open: () => new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
            ws.once('error', () => {});
        }),
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

