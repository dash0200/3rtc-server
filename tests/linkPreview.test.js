// Link previews: what may be fetched, and reading a page's title and image.
// Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPublicAddress, previewableUrl, parsePreview, linkPreview, allowed, resetRateLimits } from '../linkPreview.js';
import { startServer } from './helpers.js';

describe('link preview: only public addresses', () => {
    it('refuses private, loopback, link-local, metadata and CGNAT addresses', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '224.0.0.1']) {
            assert.equal(isPublicAddress(ip), false, ip);
        }
        for (const ip of ['8.8.8.8', '142.250.183.14', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
            assert.equal(isPublicAddress(ip), true, ip);
        }
        assert.equal(isPublicAddress('not-an-ip'), false);
    });

    it('accepts only plain http(s) links on standard ports', () => {
        assert.ok(previewableUrl('https://example.com/page?x=1#frag'));
        assert.equal(previewableUrl('https://example.com/page#frag').hash, '');
        for (const bad of [
            'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com',
            'http://example.com:8080/', 'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/',
            'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/',
            'http://printer.local/', 'not a url', `https://example.com/${'a'.repeat(2100)}`, 42
        ]) {
            assert.equal(previewableUrl(bad), null, String(bad).slice(0, 60));
        }
    });
});

describe('link preview: reading a page', () => {
    const page = new URL('https://news.example.com/story');

    it('takes Open Graph tags first, in either attribute order, decoding entities', () => {
        const html = `<html><head><title>Fallback</title>
            <meta content="Big &amp; Bold" property="og:title">
            <meta property='og:description' content='A &quot;story&quot; &#8212; here'>
            <meta property="og:image" content="/img/cover.jpg">
            <meta property="og:site_name" content="Example News"></head><body>…</body></html>`;
        assert.deepEqual(parsePreview(html, page), {
            url: 'https://news.example.com/story',
            title: 'Big & Bold',
            description: 'A "story" — here',
            image: 'https://news.example.com/img/cover.jpg',
            siteName: 'Example News'
        });
    });

    it('falls back to <title>, and the host name for the site', () => {
        const p = parsePreview('<head><title>  Just\n a   title </title></head>', page);
        assert.equal(p.title, 'Just a title');
        assert.equal(p.siteName, 'news.example.com');
        assert.equal(p.image, '');
    });

    it('drops images that are not https, and pages without a title', () => {
        const p = parsePreview('<title>T</title><meta property="og:image" content="http://x.com/a.png">', page);
        assert.equal(p.image, '');
        assert.equal(parsePreview('<head></head>', page), null);
        assert.equal(parsePreview('<meta property="og:image" content="javascript:alert(1)"><title>T</title>', page).image, '');
    });

    it('cuts long titles and strips control characters', () => {
        const p = parsePreview(`<title>${'x'.repeat(500)}\u0007</title>`, page);
        assert.equal(p.title.length, 200);
        assert.ok(!p.title.includes('\u0007'));
    });
});

describe('link preview: refuses to fetch from this machine', () => {
    let target;
    let port;
    let hits = 0;
    before(async () => {
        target = http.createServer((req, res) => {
            hits++;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<title>secret</title>');
        });
        await new Promise((r) => target.listen(0, '127.0.0.1', r));
        port = target.address().port;
    });
    after(() => target.close());

    it('never connects to a local server, by address or by a name that resolves to it', async () => {
        assert.equal(await linkPreview(`http://127.0.0.1:${port}/`), null);
        assert.equal(await linkPreview('http://localhost/'), null);
        // localtest.me-style names resolve to 127.0.0.1; even when DNS works the address is checked
        assert.equal(await linkPreview('http://127.0.0.1.nip.io/'), null);
        assert.equal(hits, 0, 'the local server was never reached');
    });
});

describe('link preview: the HTTP endpoint', () => {
    let server;
    before(async () => { server = await startServer({ LINK_PREVIEW_PER_MINUTE: '3' }); });
    after(() => server.proc.kill());

    const endpoint = (url) => `${server.url.replace('ws:', 'http:')}/api/link-preview?url=${encodeURIComponent(url)}`;

    it('answers 404 for a link it may not fetch, then rate-limits', async () => {
        assert.equal((await fetch(endpoint('http://127.0.0.1/'))).status, 404);
        assert.equal((await fetch(endpoint('file:///etc/passwd'))).status, 404);
        assert.equal((await fetch(endpoint('http://10.0.0.1/'))).status, 404);
        const limited = await fetch(endpoint('http://10.0.0.2/'));
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get('cache-control'), 'no-store');
    });

    it('maintains rate limit under high-volume address rotation without clearing all entries (SEC-02)', () => {
        resetRateLimits();
        const badIp = '198.51.100.1';
        for (let i = 0; i < 30; i++) {
            assert.equal(allowed(badIp), true);
        }
        // 31st request is blocked
        assert.equal(allowed(badIp), false);

        // Flooding 1,000 distinct addresses must not clear badIp's restriction
        for (let i = 0; i < 1000; i++) {
            allowed(`203.0.113.${i % 250}-${i}`);
        }

        // badIp must still be rate limited (previously asked.clear() wiped this!)
        assert.equal(allowed(badIp), false);
        resetRateLimits();
    });
});
