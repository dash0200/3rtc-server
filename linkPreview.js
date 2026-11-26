/**
 * Link previews for chat: GET /api/link-preview?url=https://… -> { url, title, description, image,
 * siteName } read from the page's <title> and Open Graph tags (YouTube through its oEmbed).
 *
 * The server fetches pages for the app (a browser can't read other sites), so it must not become a
 * way into private networks or a free proxy:
 * - only http(s) on the standard ports, no user:password@;
 * - every address the name resolves to must be public (no loopback, private, link-local, cloud
 *   metadata, CGNAT, multicast…), and the connection goes to the address that was checked (no DNS
 *   rebinding); each redirect (at most 3) is checked the same way;
 * - at most 512 KB is read, only HTML, 6 s in all; results (and failures) are cached;
 * - each address may ask LINK_PREVIEW_PER_MINUTE times a minute (30).
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { log } from './log.js';
import { getCorsHeaders } from './quickPicks.js';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const CACHE_MAX = 500;
const CACHE_OK_MS = 6 * 60 * 60 * 1000;
const CACHE_FAIL_MS = 10 * 60 * 1000;
const PER_MINUTE = Math.max(1, Number(process.env.LINK_PREVIEW_PER_MINUTE) || 30);
const USER_AGENT = 'Mozilla/5.0 (compatible; 3RTC-LinkPreview/1.0; +https://3rtc.me)';

// Addresses a preview must never reach
const blocked = new net.BlockList();
/** @type {Array<[string, number]>} */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
// (IPv4-mapped and NAT64 addresses are checked as the IPv4 address they carry, in isPublicAddress:
// a BlockList rule for them would also match every plain IPv4 address)
/** @type {Array<[string, number]>} */
const BLOCKED_V6 = [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
];
for (const [addr, bits] of BLOCKED_V4) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of BLOCKED_V6) blocked.addSubnet(addr, bits, 'ipv6');

/** A public address a preview may connect to. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64) reach an IPv4 address: check that one
    const lower = address.toLowerCase();
    const carried = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1]
      ?? hexToV4(/^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower));
    if (carried) return isPublicAddress(carried);
    if (/^(?:::ffff:|64:ff9b::)/.test(lower)) return false;
  }
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** ["…", "7f00", "1"] -> "127.0.0.1" */
function hexToV4(m) {
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** The URL if a preview may be fetched for it, else null. */
export function previewableUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (net.isIP(host) && !isPublicAddress(host)) return null;
  url.hash = '';
  return url;
}

// dns.lookup for http(s).request: only public addresses, so the socket goes where we checked
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new Error('blocked address'));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** GET `url` (already checked), following checked redirects; resolves { url, type, body } or null. */
function fetchPage(url, deadline, redirects = 0) {
  return new Promise((settle) => {
    const left = deadline - Date.now();
    if (left <= 0) return settle(null);
    // The whole fetch, redirects included, ends at the deadline
    let timer = null;
    const resolve = (value) => {
      clearTimeout(timer);
      settle(value);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: safeLookup,
      timeout: left,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9',
        'Accept-Language': 'en'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return resolve(null);
        let next;
        try {
          next = previewableUrl(new URL(res.headers.location, url).toString());
        } catch {
          next = null;
        }
        return next ? resolve(fetchPage(next, deadline, redirects + 1)) : resolve(null);
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (status !== 200 || !(type.includes('html') || type.includes('json'))) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      let size = 0;
      const done = () => resolve({ url, type, body: Buffer.concat(chunks).toString('utf8') });
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        // Enough: the limit, or the end of <head> (the tags we need are there)
        if (size >= MAX_BYTES || (type.includes('html') && /<\/head>/i.test(chunk.toString('latin1')))) {
          res.destroy();
          done();
        }
      });
      res.on('end', done);
      res.on('error', () => resolve(null));
    });
    timer = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, left);
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s, max) => {
  if (typeof s !== 'string') return '';
  const one = decodeEntities(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** An image address safe to show: absolute https only. */
function cleanImage(raw, base) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(decodeEntities(raw.trim()), base);
    return url.protocol === 'https:' && url.toString().length <= 1000 ? url.toString() : '';
  } catch {
    return '';
  }
}

/** The preview from a page's HTML (pure, for tests). */
export function parsePreview(html, pageUrl) {
  const head = html.slice(0, MAX_BYTES);
  const meta = new Map();
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !meta.has(key)) meta.set(key, content[1] ?? content[2] ?? '');
  }
  const title = meta.get('og:title') || meta.get('twitter:title') || /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] || '';
  const preview = {
    url: pageUrl.toString(),
    title: clean(title, 200),
    description: clean(meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || '', 300),
    image: cleanImage(meta.get('og:image') || meta.get('og:image:url') || meta.get('twitter:image') || '', pageUrl),
    siteName: clean(meta.get('og:site_name') || pageUrl.hostname.replace(/^www\./, ''), 80)
  };
  return preview.title ? preview : null;
}

const YOUTUBE_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i;

async function buildPreview(url) {
  const deadline = Date.now() + TIMEOUT_MS;
  if (YOUTUBE_RE.test(url.hostname)) {
    const oembed = previewableUrl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`);
    const page = oembed && await fetchPage(oembed, deadline);
    if (page) {
      try {
        const data = JSON.parse(page.body);
        if (data?.title) {
          return {
            url: url.toString(),
            title: clean(data.title, 200),
            description: clean(data.author_name || '', 300),
            image: cleanImage(data.thumbnail_url || '', url),
            siteName: 'YouTube'
          };
        }
      } catch { /* not JSON: no preview */ }
    }
    return null;
  }
  const page = await fetchPage(url, deadline);
  if (!page || !page.type.includes('html')) return null;
  return parsePreview(page.body, page.url);
}

/** Map<url, { at, preview, pending? }>, oldest first */
const cache = new Map();
/** Map<ip, number[]> request times in the last minute */
const asked = new Map();

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** A preview for `rawUrl` (cached), or null. */
export async function linkPreview(rawUrl) {
  const url = previewableUrl(rawUrl);
  if (!url) return null;
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < (hit.preview ? CACHE_OK_MS : CACHE_FAIL_MS))) {
    return hit.pending ? hit.pending : hit.preview;
  }
  const pending = buildPreview(url).catch(() => null);
  remember(key, { at: Date.now(), preview: null, pending });
  const preview = await pending;
  remember(key, { at: Date.now(), preview });
  return preview;
}

export function allowed(ip, now = Date.now()) {
  const recent = (asked.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MINUTE) {
    // Re-insert to refresh LRU position
    asked.delete(ip);
    asked.set(ip, recent);
    return false;
  }
  recent.push(now);
  asked.delete(ip);
  asked.set(ip, recent);

  // SEC-02: Bounded LRU & sliding expiration eviction (never clear all entries with asked.clear())
  if (asked.size > 5000) {
    for (const [k, timestamps] of asked.entries()) {
      const active = timestamps.filter((t) => now - t < 60000);
      if (active.length === 0) {
        asked.delete(k);
      } else {
        asked.set(k, active);
      }
    }
    while (asked.size > 5000) {
      const oldestKey = asked.keys().next().value;
      if (oldestKey === undefined) break;
      asked.delete(oldestKey);
    }
  }
  return true;
}

export function resetRateLimits() {
  asked.clear();
}

export async function serveLinkPreview(req, res, ip) {
  const headers = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  if (!allowed(ip || 'unknown')) {
    res.writeHead(429, { ...headers, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: 'rate-limited' }));
  }
  let raw = '';
  try {
    raw = new URL(req.url, 'http://x').searchParams.get('url') || '';
  } catch { /* unreadable: no preview */ }
  const preview = await linkPreview(raw).catch((err) => {
    log('WARN', `Link preview failed: ${err?.message || err}`);
    return null;
  });
  if (!preview) {
    res.writeHead(404, { ...headers, 'Cache-Control': 'public, max-age=600' });
    return res.end(JSON.stringify({ error: 'no-preview' }));
  }
  res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=3600' });
  res.end(JSON.stringify(preview));
}
