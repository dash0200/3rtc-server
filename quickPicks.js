/**
 * YouTube quick picks: the server fetches and caches them; browsers read GET /api/quick-picks.
 * startQuickPicks() starts the refresh schedule; serveQuickPicks(req, res) answers the endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// YouTube quick picks
// The server searches YouTube for each category and every client reads the cached result from
// GET /api/quick-picks, so YouTube API quota depends only on the refresh schedule, never on how
// many people use the app. The schedule is worked out from a daily budget (default 9,000 of the
// 10,000 free units, leaving room for restarts and retries): one refresh is 11 searches x 102
// units (search 100 + two 1-unit detail calls) + 8 trending charts x 10 countries x 1 unit =
// 1,202 units, so 7 refreshes a day, about one every 3.5 hours.
//
// Trending is per country: the app asks for ?region=GLOBAL (a worldwide mix of all the countries'
// charts, only videos that play in every one of them) unless the viewer picked a country in
// "Trending in", which gets that country's charts.
//
// Each refresh uses the next search phrase of every category, and new results are merged into a
// rolling set of up to QUICK_PICKS_POOL_SIZE videos (newest first), so frequent refreshes keep
// bringing new videos rather than the same top results. Saved videos are re-checked on every
// refresh (part of the same 1-unit call), so removed or blocked ones drop out.
//
// The API key stays here and never reaches a browser. It comes from the YOUTUBE_API_KEY
// environment variable or the private file .youtube-api-key next to server.js (deploy_gcp.py
// uploads it). Without a key the endpoint returns 503 and clients keep their built-in list.
// ---------------------------------------------------------------------------------------------
// group: how the app groups the category buttons. chart: YouTube's trending chart for that YouTube
// category, fetched for every country in QUICK_PICKS_REGIONS (1 unit each). queries: search
// phrases, one per refresh in rotation (100 units each). order/recentDays: optional search
// options (e.g. newest trailers first). region: search as seen from that country, and show the
// row first there (later in its group elsewhere).
const QUICK_PICK_CATEGORIES = [
  { id: 'trending-music', group: 'Trending', name: '🔥 Music', chart: 10 },
  { id: 'trending-entertainment', group: 'Trending', name: '🎭 Entertainment', chart: 24 },
  { id: 'trending-comedy', group: 'Trending', name: '😂 Comedy', chart: 23 },
  { id: 'trending-gaming', group: 'Trending', name: '🎮 Gaming', chart: 20 },
  { id: 'trending-film', group: 'Trending', name: '🎞️ Film & Animation', chart: 1 },
  { id: 'trending-sports', group: 'Trending', name: '🏏 Sports', chart: 17 },
  { id: 'trending-science', group: 'Trending', name: '🔬 Science & Tech', chart: 28 },
  { id: 'trending-pets', group: 'Trending', name: '🐾 Pets & Animals', chart: 15 },
  { id: 'lofi', group: 'Music', name: '🎵 Lofi Beats', queries: ['lofi hip hop', 'lofi study beats', 'lofi chill mix', 'lofi rainy night', 'lofi radio live'] },
  { id: 'chill', group: 'Music', name: '🎷 Jazz & Chill', queries: ['jazz lofi chill music', 'coffee shop jazz', 'chillhop mix', 'bossa nova cafe music', 'smooth jazz relaxing'] },
  { id: 'synthwave', group: 'Music', name: '🌆 Synthwave', queries: ['synthwave mix', 'retrowave night drive', 'outrun synthwave', 'chillwave mix', 'darksynth cyberpunk mix'] },
  { id: 'bollywood', group: 'Music', name: '🎤 Bollywood', region: 'IN', queries: ['bollywood hit songs', 'new hindi songs', 'bollywood romantic songs', 'hindi party songs', 'arijit singh songs'] },
  { id: 'south', group: 'Music', name: '🌴 South Hits', region: 'IN', queries: ['tamil hit songs', 'telugu hit songs', 'malayalam hit songs', 'kannada hit songs', 'anirudh songs'] },
  { id: 'trailers', group: 'Watch', name: '🍿 New Trailers', queries: ['official movie trailer', 'official trailer hindi', 'official teaser trailer', 'series official trailer', 'animated movie trailer'], order: 'date', recentDays: 45 },
  { id: 'standup', group: 'Watch', name: '🎙️ Stand-up', queries: ['stand up comedy india', 'stand up comedy special', 'standup comedy crowd work', 'hindi stand up comedy', 'comedy sketch'] },
  { id: 'movies', group: 'Watch', name: '🎬 Short Films', queries: ['animated short film', 'cgi animated short', 'sci-fi short film', 'pixar style short film', 'award winning short film'] },
  { id: 'documentaries', group: 'Watch', name: '🌍 Documentaries', queries: ['nature documentary 4k', 'space documentary', 'history documentary', 'science documentary', 'wildlife documentary'] },
  { id: 'space', group: 'Relax', name: '🌌 Space', queries: ['space ambient music 4k', 'deep space ambient', 'earth from space 4k', 'cosmic relaxation music', 'nasa space footage 4k'] },
  { id: 'nature', group: 'Relax', name: '🌧️ Rain & Nature', queries: ['rain sounds for sleeping', 'nature sounds 4k', 'ocean waves relaxing', 'forest ambience', 'thunderstorm sounds'] }
];
const QUICK_PICKS_POOL_SIZE = 20; // videos kept per category (newest first)
// Countries with their own trending charts (ISO 3166 codes); everyone else gets the worldwide mix
export const QUICK_PICKS_REGIONS = [...new Set((process.env.QUICK_PICKS_REGIONS || 'IN,US,GB,CA,AU,DE,FR,BR,JP,KR')
  .split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^[A-Z]{2}$/.test(r)))];
export const GLOBAL_REGION = 'GLOBAL';

/**
 * Normalizes and validates the region string to one of the supported ISO 3166 regions,
 * or GLOBAL_REGION. Bounded to strictly QUICK_PICKS_REGIONS.length + 1 values (SEC-01).
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeRegion(raw) {
  const clean = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return QUICK_PICKS_REGIONS.includes(clean) ? clean : GLOBAL_REGION;
}
const QUICK_PICKS_DAILY_UNITS = Math.min(10000, Number(process.env.QUICK_PICKS_DAILY_UNITS) || 9000);
const QUICK_PICKS_UNITS_PER_REFRESH = QUICK_PICK_CATEGORIES.reduce((sum, c) => sum + (c.chart ? QUICK_PICKS_REGIONS.length : 102), 0); // 1,202
const QUICK_PICKS_REFRESH_MS = Number(process.env.QUICK_PICKS_REFRESH_MINUTES) > 0
  ? Number(process.env.QUICK_PICKS_REFRESH_MINUTES) * 60 * 1000
  : Math.max(30 * 60 * 1000, Math.ceil((24 * 3600 * 1000) / Math.max(1, Math.floor(QUICK_PICKS_DAILY_UNITS / QUICK_PICKS_UNITS_PER_REFRESH))));
const QUICK_PICKS_RETRY_MS = 60 * 60 * 1000; // after a failure (no key, quota used up, network)
const QUICK_PICKS_CACHE_FILE = path.join(__dirname, 'quick-picks-cache.json');
// Changes whenever the categories, phrases or region change, so a saved list from an older setup
// is refreshed at startup instead of being served until the next scheduled refresh
const QUICK_PICKS_CONFIG_ID = crypto.createHash('sha256')
  .update(JSON.stringify({ regions: QUICK_PICKS_REGIONS, categories: QUICK_PICK_CATEGORIES, filters: 'no-shorts-1' })).digest('hex').slice(0, 12);
const YOUTUBE_API_BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';

// { updatedAt, config, rotation: { [categoryId]: n },
//   categories: [{ id, group, name, videos: [{ id, title, channel }] }]   (search rows)
//   trending: { [region | 'GLOBAL']: [{ id, group, name, videos }] } }
let quickPicks = null;
let quickPicksTimer = null;
const unavailableCharts = new Set(); // `${region}:${categoryId}`: charts YouTube doesn't publish for that country
const preSerializedCache = new Map();

export function invalidateQuickPicksCache() {
  preSerializedCache.clear();
}

function readYouTubeApiKey() {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(__dirname, '.youtube-api-key'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function youtubeApi(endpoint, params, key) {
  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.message || res.status;
    throw new Error(`YouTube ${endpoint} failed: ${reason}`);
  }
  return body;
}

// Only keep videos that will actually play inside 3RTC: public, embeddable, not blocked in the
// given countries, not age-restricted (age-gated videos never play in embeds), not an upcoming
// premiere.
export function isPlayableIn(video, regions) {
  const status = video.status || {};
  if (status.privacyStatus !== 'public' || status.embeddable === false || status.uploadStatus === 'rejected') return false;
  if (video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') return false;
  const restriction = video.contentDetails?.regionRestriction;
  for (const region of regions) {
    if (restriction?.blocked?.includes(region)) return false;
    if (restriction?.allowed && !restriction.allowed.includes(region)) return false;
  }
  if (video.snippet?.liveBroadcastContent === 'upcoming') return false;
  return true;
}

// ---- No Shorts ----------------------------------------------------------------------------
// YouTube has no "is a Short" flag, so: a vertical (or square) picture is a Short (the embed size
// YouTube reports for a 480-wide player shows the shape), so is anything tagged #shorts, and so
// is anything a minute or shorter (too short for watching together anyway). Live streams have no
// length, so the length rule skips them.
const MIN_SECONDS = 61;

/** ISO 8601 duration (PT4M13S) in seconds, or null. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso || '');
  if (!m) return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

export function isShort(video) {
  const snippet = video.snippet || {};
  const text = `${snippet.title || ''} ${snippet.description || ''} ${(snippet.tags || []).join(' ')}`;
  if (/#shorts?\b/i.test(text)) return true;
  const width = Number(video.player?.embedWidth);
  const height = Number(video.player?.embedHeight);
  if (width > 0 && height > 0 && height >= width * 0.9) return true;
  if (snippet.liveBroadcastContent !== 'live') {
    const seconds = parseDuration(video.contentDetails?.duration);
    if (seconds !== null && seconds > 0 && seconds < MIN_SECONDS) return true;
  }
  return false;
}

const isGoodPick = (video, regions = QUICK_PICKS_REGIONS) => isPlayableIn(video, regions) && !isShort(video);

function toPick(video) {
  const pick = { id: video.id, title: video.snippet?.title || 'YouTube video', channel: video.snippet?.channelTitle || '' };
  // Length badge on the card (Figma): seconds, or live
  if (video.snippet?.liveBroadcastContent === 'live') pick.live = true;
  else {
    const seconds = parseDuration(video.contentDetails?.duration);
    if (seconds) pick.seconds = seconds;
  }
  return pick;
}

/** New videos for a category merged with its saved ones (re-checked), newest first. */
// player + maxWidth: YouTube reports the embed size, which shows vertical videos (Shorts)
const DETAILS = { part: 'snippet,status,contentDetails,player', maxWidth: 480 };

/** One country's trending chart for a category (1 unit; 50: room to drop Shorts): the videos that play there, in order. */
async function fetchChart(category, region, key) {
  const chart = /** @type {any} */ (await youtubeApi('videos', {
    ...DETAILS, chart: 'mostPopular', videoCategoryId: category.chart, regionCode: region, maxResults: 50
  }, key));
  return (chart.items || []).filter((v) => isGoodPick(v, [region]));
}

/**
 * The worldwide mix for a category from the countries' charts: their top videos taken in turn
 * (1st of each country, then 2nd...), each video once, only ones that play in all those countries.
 */
export function mixCharts(chartsByRegion, size = QUICK_PICKS_POOL_SIZE) {
  const lists = Object.values(chartsByRegion);
  const regions = Object.keys(chartsByRegion);
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < size && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const v = list[i];
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      if (isPlayableIn(v, regions)) out.push(v);
      if (out.length >= size) break;
    }
  }
  return out;
}

async function fetchCategory(category, key, previousVideos, rotation) {
  const details = DETAILS;
  // search: 100 units whatever the count, so ask for 50 (room to drop Shorts). YouTube filters
  // to videos that can play outside youtube.com.
  const query = category.queries[rotation % category.queries.length];
  const search = /** @type {any} */ (await youtubeApi('search', {
    part: 'id', type: 'video', q: query, maxResults: 50, safeSearch: 'moderate',
    videoEmbeddable: 'true', videoSyndicated: 'true', ...(category.region ? { regionCode: category.region } : {}),
    ...(category.order ? { order: category.order } : {}),
    ...(category.recentDays ? { publishedAfter: new Date(Date.now() - category.recentDays * 86400000).toISOString() } : {})
  }, key));
  const newIds = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  // Details for the new results and a re-check of the saved ones: 1 unit per 50 ids
  const ids = [...new Set([...newIds, ...previousVideos.map((v) => v.id)])];
  if (ids.length === 0) return [];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const videos = /** @type {any} */ (await youtubeApi('videos', { ...details, id: ids.slice(i, i + 50).join(',') }, key));
    for (const v of videos.items || []) byId.set(v.id, v);
  }
  return ids.map((id) => byId.get(id)).filter((v) => v && isGoodPick(v))
    .slice(0, QUICK_PICKS_POOL_SIZE).map(toPick);
}

async function refreshQuickPicks() {
  const key = readYouTubeApiKey();
  if (!key) {
    log('INFO', 'Quick picks: no YouTube API key set, clients use their built-in list');
    return false;
  }
  const rotation = { ...(quickPicks?.rotation || {}) };
  /** @type {any[]} */
  const categories = [];
  /** @type {Record<string, any[]>} */
  const trending = Object.fromEntries([...QUICK_PICKS_REGIONS, GLOBAL_REGION].map((r) => [r, []]));
  let refreshed = 0;
  let quotaHit = false;
  const noteError = (/** @type {any} */ err) => {
    if (/quota/i.test(err?.message || '')) quotaHit = true; // no point spending more calls today
  };

  // Trending: every country's chart for each category, and the worldwide mix of them
  for (const category of QUICK_PICK_CATEGORIES.filter((c) => c.chart)) {
    const charts = {};
    for (const region of QUICK_PICKS_REGIONS) {
      if (!quotaHit && !unavailableCharts.has(`${region}:${category.id}`)) {
        try {
          charts[region] = await fetchChart(category, region, key);
        } catch (/** @type {any} */ err) {
          log('WARN', `Quick picks: ${category.id} ${region}: ${err.message}`);
          noteError(err);
          if (/chartNotFound|notFound|invalid/i.test(err.message)) unavailableCharts.add(`${region}:${category.id}`);
        }
      }
      const videos = charts[region]?.slice(0, QUICK_PICKS_POOL_SIZE).map(toPick);
      const previous = quickPicks?.trending?.[region]?.find((c) => c.id === category.id);
      if (videos?.length) {
        trending[region].push({ id: category.id, group: category.group, name: category.name, videos });
        refreshed += 1;
      } else if (previous) {
        trending[region].push({ ...previous, group: category.group, name: category.name }); // keep its last good list
      }
    }
    const mixed = mixCharts(Object.fromEntries(Object.entries(charts).filter(([, list]) => list.length))).map(toPick);
    const previousMix = quickPicks?.trending?.[GLOBAL_REGION]?.find((c) => c.id === category.id);
    if (mixed.length) trending[GLOBAL_REGION].push({ id: category.id, group: category.group, name: category.name, videos: mixed });
    else if (previousMix) trending[GLOBAL_REGION].push({ ...previousMix, group: category.group, name: category.name });
  }

  // Search rows: the same for everyone
  for (const category of QUICK_PICK_CATEGORIES.filter((c) => !c.chart)) {
    const previous = quickPicks?.categories?.find((c) => c.id === category.id);
    if (!quotaHit) {
      try {
        const videos = await fetchCategory(category, key, previous?.videos || [], rotation[category.id] || 0);
        rotation[category.id] = (rotation[category.id] || 0) + 1;
        if (videos.length > 0) {
          categories.push({ id: category.id, group: category.group, name: category.name, videos });
          refreshed += 1;
          continue;
        }
      } catch (/** @type {any} */ err) {
        log('WARN', `Quick picks: ${category.id}: ${err.message}`);
        noteError(err);
      }
    }
    // Couldn't refresh this one: keep its last good list rather than dropping it
    if (previous) categories.push({ ...previous, group: category.group, name: category.name });
  }
  // Nothing new (bad key, quota used up, YouTube down): keep serving the last list, retry soon
  if (refreshed === 0 || (categories.length === 0 && trending[GLOBAL_REGION].length === 0)) return false;
  quickPicks = { updatedAt: new Date().toISOString(), config: QUICK_PICKS_CONFIG_ID, rotation, categories, trending };
  invalidateQuickPicksCache();
  try {
    fs.writeFileSync(QUICK_PICKS_CACHE_FILE, JSON.stringify(quickPicks));
  } catch (/** @type {any} */ err) {
    log('WARN', `Quick picks: could not save cache: ${err.message}`);
  }
  log('INFO', `Quick picks refreshed: ${categories.map((c) => `${c.id}=${c.videos.length}`).join(' ')}; trending rows ${Object.entries(trending).map(([r, list]) => `${r}=${list.length}`).join(' ')}`);
  return true;
}

function scheduleQuickPicks(delayMs) {
  clearTimeout(quickPicksTimer);
  quickPicksTimer = setTimeout(async () => {
    let ok = false;
    try {
      ok = await refreshQuickPicks();
    } catch (/** @type {any} */ err) {
      log('WARN', `Quick picks refresh failed: ${err.message}`);
    }
    scheduleQuickPicks(ok ? QUICK_PICKS_REFRESH_MS : QUICK_PICKS_RETRY_MS);
  }, delayMs);
  quickPicksTimer.unref?.();
}

// A restart reuses the saved list instead of spending quota again
export function startQuickPicks() {
  const perDay = Math.round((24 * 3600 * 1000) / QUICK_PICKS_REFRESH_MS);
  log('INFO', `Quick picks: refresh every ${Math.round(QUICK_PICKS_REFRESH_MS / 60000)} min (~${perDay}/day, ~${perDay * QUICK_PICKS_UNITS_PER_REFRESH} of 10,000 daily units)`);
  let delay = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(QUICK_PICKS_CACHE_FILE, 'utf8'));
    if (saved?.categories?.length) {
      quickPicks = saved; // served until the refresh below, and its videos seed the new lists
      invalidateQuickPicksCache();
      if (saved.config === QUICK_PICKS_CONFIG_ID) {
        const age = Date.now() - Date.parse(saved.updatedAt);
        delay = Math.max(0, QUICK_PICKS_REFRESH_MS - (Number.isFinite(age) ? age : QUICK_PICKS_REFRESH_MS));
      } else {
        log('INFO', 'Quick picks: categories changed since the saved list, refreshing now');
      }
    }
  } catch {
    // no saved list yet
  }
  scheduleQuickPicks(delay);
}

/**
 * What one visitor gets: their country's trending rows (or the worldwide mix) first, then the
 * search rows, with rows made for their country first in their group and rows made for another
 * country last in it. (pure, for tests)
 */
export function picksFor(data, requested) {
  const region = QUICK_PICKS_REGIONS.includes(requested) ? requested : GLOBAL_REGION;
  // A list saved by an older server has no per-country trending: its rows are used as they are
  const trending = data.trending ? (data.trending[region]?.length ? data.trending[region] : data.trending[GLOBAL_REGION] || []) : [];
  const rank = (row) => {
    const def = QUICK_PICK_CATEGORIES.find((d) => d.id === row.id);
    return def?.region ? (def.region === region ? 0 : 2) : 1;
  };
  const groupOrder = [...new Set((data.categories || []).map((c) => c.group))];
  const rows = (data.categories || [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (groupOrder.indexOf(a.row.group) - groupOrder.indexOf(b.row.group)) || (rank(a.row) - rank(b.row)) || (a.index - b.index))
    .map(({ row }) => row);
  return {
    updatedAt: data.updatedAt,
    region,
    regions: QUICK_PICKS_REGIONS,
    categories: [...trending, ...rows]
  };
}

/**
 * Validate request origin against allowed 3RTC domains and local development environments.
 */
export function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    // Allow localhost and loopback interfaces for local development
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;

    // In development, also allow LAN IP addresses for phone testing on local Wi-Fi
    if (process.env.NODE_ENV !== 'production') {
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(host)) return true;
    }

    // Allow official 3rtc.me domain and its subdomains
    if (host === '3rtc.me' || host.endsWith('.3rtc.me')) return true;

    // Allow Vercel preview/production deployments
    if (host.endsWith('.vercel.app')) return true;

    // Allow custom APP_URL if configured
    if (process.env.APP_URL) {
      try {
        const appUrl = new URL(process.env.APP_URL);
        if (appUrl.origin === url.origin) return true;
      } catch {
        // ignore malformed APP_URL
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function getCorsHeaders(req) {
  const origin = req.headers?.origin;
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN'
  };

  if (!origin) {
    // Direct server-to-server or test requests without Origin header
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

export function serveQuickPicks(req, res) {
  const headers = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  if (!quickPicks) {
    res.writeHead(503, { ...headers, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ categories: [] }));
  }
  let requested = '';
  try {
    requested = new URL(req.url, 'http://x').searchParams.get('region') || '';
  } catch {
    // unreadable address: the worldwide list
  }
  const regionKey = normalizeRegion(requested);

  let body = preSerializedCache.get(regionKey);
  if (!body) {
    body = JSON.stringify(picksFor(quickPicks, regionKey));
    preSerializedCache.set(regionKey, body);
  }

  res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=900' });
  res.end(body);
}

