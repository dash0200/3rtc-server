// Quick picks: no Shorts; trending per country.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isShort,
    parseDuration,
    isPlayableIn,
    mixCharts,
    picksFor,
    QUICK_PICKS_REGIONS,
    GLOBAL_REGION,
    normalizeRegion,
    serveQuickPicks,
    invalidateQuickPicksCache
} from '../quickPicks.js';

const video = ({ title = 'A video', description = '', duration = 'PT4M10S', w = 480, h = 270, live = 'none', tags } = {}) => ({
    snippet: { title, description, liveBroadcastContent: live, tags },
    contentDetails: { duration },
    player: { embedWidth: String(w), embedHeight: String(h) }
});

describe('no Shorts in quick picks', () => {
    it('reads YouTube durations', () => {
        assert.equal(parseDuration('PT4M13S'), 253);
        assert.equal(parseDuration('PT1H2M3S'), 3723);
        assert.equal(parseDuration('P0D'), 0);
        assert.equal(parseDuration('nope'), null);
    });
    it('keeps normal landscape videos, including 2-3 minute songs and trailers', () => {
        assert.equal(isShort(video()), false);
        assert.equal(isShort(video({ duration: 'PT2M30S' })), false);
    });
    it('drops vertical or square videos (that is what a Short is)', () => {
        assert.equal(isShort(video({ w: 270, h: 480, duration: 'PT2M50S' })), true);
        assert.equal(isShort(video({ w: 480, h: 480 })), true);
    });
    it('drops anything tagged #shorts, and anything a minute or shorter', () => {
        assert.equal(isShort(video({ title: 'Funny cat #Shorts' })), true);
        assert.equal(isShort(video({ description: 'watch more #short' })), true);
        assert.equal(isShort(video({ tags: ['#shorts'] })), true);
        assert.equal(isShort(video({ duration: 'PT45S' })), true);
    });
    it('keeps live streams (they have no length)', () => {
        assert.equal(isShort(video({ duration: 'P0D', live: 'live' })), false);
    });
});


const v = (id, restriction) => ({ id, status: { privacyStatus: 'public', embeddable: true }, contentDetails: restriction ? { regionRestriction: restriction } : {}, snippet: {} });

describe('trending per country', () => {
    it('a video blocked (or not allowed) in a country does not play there', () => {
        assert.equal(isPlayableIn(v('a', { blocked: ['DE'] }), ['IN']), true);
        assert.equal(isPlayableIn(v('a', { blocked: ['DE'] }), ['IN', 'DE']), false);
        assert.equal(isPlayableIn(v('a', { allowed: ['IN', 'US'] }), ['US']), true);
        assert.equal(isPlayableIn(v('a', { allowed: ['IN', 'US'] }), ['US', 'GB']), false);
    });
    it('the worldwide mix takes the countries\' top videos in turn, once each, only ones that play everywhere', () => {
        const mix = mixCharts({
            IN: [v('in1'), v('shared'), v('in3')],
            US: [v('us1'), v('us2', { blocked: ['IN'] }), v('shared')],
            GB: [v('shared'), v('gb2')]
        }, 10).map((x) => x.id);
        assert.deepEqual(mix, ['in1', 'us1', 'shared', 'gb2', 'in3']);
        assert.equal(mixCharts({ IN: [v('a'), v('b'), v('c')] }, 2).length, 2);
    });
    it('each visitor gets their country\'s trending (or the worldwide mix), then the other rows', () => {
        const row = (id, group) => ({ id, group, name: id, videos: [{ id: 'xxxxxxxxxxx' }] });
        const data = {
            updatedAt: 'now',
            trending: { IN: [row('trending-music', 'Trending')], US: [row('trending-music', 'Trending'), row('trending-film', 'Trending')], GLOBAL: [row('trending-comedy', 'Trending')] },
            categories: [row('lofi', 'Music'), row('chill', 'Music'), row('bollywood', 'Music'), row('south', 'Music'), row('trailers', 'Watch')]
        };
        assert.ok(QUICK_PICKS_REGIONS.includes('IN') && QUICK_PICKS_REGIONS.includes('US'));
        const india = picksFor(data, 'IN');
        assert.equal(india.region, 'IN');
        assert.deepEqual(india.categories.map((c) => c.id), ['trending-music', 'bollywood', 'south', 'lofi', 'chill', 'trailers']);
        const us = picksFor(data, 'US');
        assert.deepEqual(us.categories.map((c) => c.id), ['trending-music', 'trending-film', 'lofi', 'chill', 'bollywood', 'south', 'trailers']);
        const elsewhere = picksFor(data, 'NZ');
        assert.equal(elsewhere.region, 'GLOBAL');
        assert.equal(elsewhere.categories[0].id, 'trending-comedy');
        assert.equal(picksFor(data, '').region, 'GLOBAL');
        // a list saved by an older server (no per-country trending) still works
        assert.deepEqual(picksFor({ categories: [row('trending-music', 'Trending'), row('lofi', 'Music')] }, 'US').categories.map((c) => c.id), ['trending-music', 'lofi']);
    });
});

describe('quick picks pre-serialization caching and headers (M-05, L-01)', () => {
    it('invalidates cache without errors', () => {
        assert.doesNotThrow(() => invalidateQuickPicksCache());
    });

    it('serves quick picks response with defensive security headers', () => {
        let headersSent = {};
        let statusSent = 0;
        const req = { method: 'GET', url: '/api/quick-picks?region=IN' };
        const res = {
            writeHead(status, headers) {
                statusSent = status;
                headersSent = headers;
            },
            end() {}
        };
        serveQuickPicks(req, res);
        assert.ok([200, 503].includes(statusSent));
        assert.equal(headersSent['X-Content-Type-Options'], 'nosniff');
        assert.equal(headersSent['X-Frame-Options'], 'SAMEORIGIN');
    });

    it('normalizes arbitrary or malicious region query parameters (SEC-01)', () => {
        assert.equal(normalizeRegion('IN'), 'IN');
        assert.equal(normalizeRegion('in'), 'IN');
        assert.equal(normalizeRegion('US'), 'US');
        assert.equal(normalizeRegion('ATTACKER_INJECTION_PARAM_TO_EXHAUST_HEAP'), GLOBAL_REGION);
        assert.equal(normalizeRegion(''), GLOBAL_REGION);
        assert.equal(normalizeRegion(null), GLOBAL_REGION);
        assert.equal(normalizeRegion(undefined), GLOBAL_REGION);
    });
});

