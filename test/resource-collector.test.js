import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ResourceCollector } from '../src/index.js';
import { CHECK_ASSETS_URL, defaultLocation, installBrowserGlobals, jsonResponse, urisOf, validOptions } from './helpers.js';

describe('constructor validation', () => {
    test('requires publicToken', () => {
        assert.throws(() => new ResourceCollector({ apiDomain: validOptions.apiDomain }), /publicToken/);
    });

    test('requires a matching apiDomain', () => {
        assert.throws(() => new ResourceCollector({ publicToken: 'x', apiDomain: 'evil.example.com' }), /apiDomain/);
    });

    test('rejects unknown resource types up front', () => {
        assert.throws(() => new ResourceCollector({ ...validOptions, resourceTypes: ['js', 'png'] }), /png/);
    });

    test('rejects an empty resourceTypes array', () => {
        assert.throws(() => new ResourceCollector({ ...validOptions, resourceTypes: [] }), /non-empty/);
    });

    test('rejects a non-function onError', () => {
        assert.throws(() => new ResourceCollector({ ...validOptions, onError: 'nope' }), /onError/);
    });

    test('exposes supported resource types', () => {
        assert.deepEqual([...ResourceCollector.RESOURCE_TYPES], ['js', 'css']);
    });
});

describe('collection', () => {
    let env;

    beforeEach(() => {
        env = installBrowserGlobals();
    });

    afterEach(() => {
        env.restore();
    });

    test('is a no-op without PerformanceObserver', () => {
        delete globalThis.PerformanceObserver;
        const collector = new ResourceCollector(validOptions).start();
        assert.equal(collector.running, false);
    });

    test('start is idempotent', () => {
        const collector = new ResourceCollector(validOptions).start().start();
        assert.equal(collector.running, true);
        assert.equal(env.observers.length, 1);
    });

    test('filters by resource type and deduplicates', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit([
            'https://cdn.example/app.js',
            'https://cdn.example/app.js',
            'https://cdn.example/app.js?v=2',
            'https://cdn.example/style.css',
            'https://cdn.example/logo.png',
        ]);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.equal(uploads.length, 1);
        assert.deepEqual(urisOf(uploads[0]), ['https://cdn.example/app.js', 'https://cdn.example/app.js?v=2']);
    });

    test('classifies scripts by initiator type, not by extension', async () => {
        const collector = new ResourceCollector({ ...validOptions, resourceTypes: ['js', 'css'] }).start();
        env.observers[0].emit([
            { name: 'https://js.stripe.com/v3/', initiatorType: 'script' },
            { name: 'https://www.googletagmanager.com/gtag/js?id=G-1', initiatorType: 'script' },
            { name: 'https://cdn.example/chunk.mjs', initiatorType: 'other' },
            { name: 'https://cdn.example/legacy.JS?v=1#x', initiatorType: 'other' },
            { name: 'https://cdn.example/style.css', initiatorType: 'link' },
            { name: 'https://cdn.example/api/data', initiatorType: 'fetch' },
            { name: 'https://cdn.example/api/data.json?callback=js', initiatorType: 'xmlhttprequest' },
            { name: 'https://cdn.example/font.woff2', initiatorType: 'css' },
            { name: 'https://cdn.example/hero.png', initiatorType: 'img' },
            { name: 'https://cdn.example/frame', initiatorType: 'iframe' },
        ]);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0].body.resources, [
            { uri: 'https://js.stripe.com/v3/', type: 'js' },
            { uri: 'https://www.googletagmanager.com/gtag/js?id=G-1', type: 'js' },
            { uri: 'https://cdn.example/chunk.mjs', type: 'js' },
            { uri: 'https://cdn.example/legacy.JS?v=1#x', type: 'js' },
            { uri: 'https://cdn.example/style.css', type: 'css' },
        ]);
    });

    test('does not report a stylesheet as a script when only js is configured', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit([
            { name: 'https://cdn.example/style.css', initiatorType: 'link' },
            { name: 'https://cdn.example/theme', initiatorType: 'link' },
        ]);
        await collector.stop();

        assert.equal(env.fetchCalls.length, 0);
    });

    test('tolerates entries without an initiator type', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit([{ name: 'https://cdn.example/app.js' }, { name: 'https://cdn.example/app' }]);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(urisOf(uploads[0]), ['https://cdn.example/app.js']);
    });

    test('reports the page URL without query string or fragment', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0].body, {
            pageUrl: 'https://shop.example/checkout',
            resources: [{ uri: 'https://cdn.example/app.js', type: 'js' }],
        });
    });

    test('sends one request per page URL when the location changes between entries', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        Object.assign(globalThis.location, defaultLocation({ pathname: '/checkout/payment' }));
        env.observers[0].emit([{ name: 'https://js.stripe.com/v3/', initiatorType: 'script' }]);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(
            uploads.map((u) => u.body),
            [
                {
                    pageUrl: 'https://shop.example/checkout',
                    resources: [{ uri: 'https://cdn.example/app.js', type: 'js' }],
                },
                {
                    pageUrl: 'https://shop.example/checkout/payment',
                    resources: [{ uri: 'https://js.stripe.com/v3/', type: 'js' }],
                },
            ],
        );
    });

    test('reports a URI again when it is seen on another page', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        env.observers[0].emit(['https://cdn.example/app.js']);
        Object.assign(globalThis.location, defaultLocation({ pathname: '/cart' }));
        env.observers[0].emit(['https://cdn.example/app.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(
            uploads.map((u) => u.body.pageUrl),
            ['https://shop.example/checkout', 'https://shop.example/cart'],
        );
    });

    test('omits pageUrl when location is unavailable', async () => {
        env.restore();
        env = installBrowserGlobals({ location: null });

        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(uploads[0].body, { resources: [{ uri: 'https://cdn.example/app.js', type: 'js' }] });
    });

    test('reports its own pinned CDN script so it appears in the inventory', async () => {
        const ownScript =
            'https://cdn.jsdelivr.net/npm/assetassure-resource-collector@0.4.0/dist/assetassure-resource-collector.min.js';
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit([ownScript, 'https://cdn.example/app.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(urisOf(uploads[0]), [ownScript, 'https://cdn.example/app.js']);
    });

    test('honours resourceTypes option', async () => {
        const collector = new ResourceCollector({ ...validOptions, resourceTypes: ['css'] }).start();
        env.observers[0].emit(['https://cdn.example/app.js', 'https://cdn.example/style.css']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.deepEqual(urisOf(uploads[0]), ['https://cdn.example/style.css']);
    });

    test('sends full batches eagerly, each straight to /check-assets', async () => {
        const collector = new ResourceCollector({ ...validOptions, batchSize: 2 }).start();
        env.observers[0].emit(['https://a/1.js', 'https://a/2.js', 'https://a/3.js', 'https://a/4.js', 'https://a/5.js']);
        await collector.flush();

        assert.equal(env.fetchCalls.length, 3, 'no request other than the uploads');
        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.equal(uploads.length, 3);
        assert.deepEqual(uploads.map((u) => urisOf(u).length), [2, 2, 1]);
    });

    test('sends Basic auth built from the public token', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        for (const call of env.fetchCalls) {
            assert.equal(call.init.headers.Authorization, `Basic ${btoa('pk_test:')}`);
            assert.equal(call.init.keepalive, true);
        }
    });

    test('stop disconnects, removes listeners and flushes', async () => {
        const collector = new ResourceCollector(validOptions).start();
        assert.equal(env.listeners.window.has('pagehide'), true);
        assert.equal(env.listeners.document.has('visibilitychange'), true);

        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(collector.running, false);
        assert.equal(env.observers[0].disconnected, true);
        assert.equal(env.listeners.window.size, 0);
        assert.equal(env.listeners.document.size, 0);
        assert.equal(env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL).length, 1);
    });

    test('flushes on visibilitychange only when hidden', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://a/1.js']);

        env.document.visibilityState = 'visible';
        env.listeners.document.get('visibilitychange')();
        assert.equal(env.fetchCalls.length, 0, 'no flush while visible');

        env.observers[0].emit(['https://a/2.js']);
        env.document.visibilityState = 'hidden';
        env.listeners.document.get('visibilitychange')();
        assert.equal(env.fetchCalls.length, 1, 'batch posted as soon as the page is hidden');

        await collector.stop();
        const uploads = env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL);
        assert.equal(uploads.length, 1);
        assert.deepEqual(urisOf(uploads[0]), ['https://a/1.js', 'https://a/2.js']);
    });

    test('flushes on pagehide', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://a/1.js']);
        env.listeners.window.get('pagehide')();
        await collector.flush();
        assert.equal(env.fetchCalls.filter((c) => c.url === CHECK_ASSETS_URL).length, 1);
    });
});

describe('error handling', () => {
    let env;

    afterEach(() => {
        env?.restore();
    });

    test('reports a rejected page (403) through onError without retrying', async () => {
        let uploadAttempts = 0;
        env = installBrowserGlobals({
            fetchImpl: () => {
                uploadAttempts += 1;
                return jsonResponse({ message: 'Page URL is not an allowed payment page domain.' }, 403);
            },
        });
        const errors = [];
        const collector = new ResourceCollector({ ...validOptions, onError: (e) => errors.push(e) }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(uploadAttempts, 1);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /HTTP 403/);
    });

    test('reports upload failures through onError', async () => {
        env = installBrowserGlobals({ fetchImpl: () => jsonResponse({}, 500) });
        const errors = [];
        const collector = new ResourceCollector({ ...validOptions, onError: (e) => errors.push(e) }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /HTTP 500/);
    });

    test('swallows errors silently when no onError is given', async () => {
        env = installBrowserGlobals({ fetchImpl: () => Promise.reject(new Error('network down')) });
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://a/1.js']);
        await assert.doesNotReject(() => collector.stop());
    });

    test('a throwing onError handler does not propagate', async () => {
        env = installBrowserGlobals({ fetchImpl: () => Promise.reject(new Error('network down')) });
        const collector = new ResourceCollector({
            ...validOptions,
            onError: () => {
                throw new Error('handler exploded');
            },
        }).start();
        env.observers[0].emit(['https://a/1.js']);
        await assert.doesNotReject(() => collector.stop());
    });
});
