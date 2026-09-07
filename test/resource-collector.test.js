import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ResourceCollector } from '../src/index.js';
import { defaultLocation, installBrowserGlobals, jsonResponse, validOptions } from './helpers.js';

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

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0].body.uris, ['https://cdn.example/app.js', 'https://cdn.example/app.js?v=2']);
    });

    test('reports the page URL without query string or fragment', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0].body, {
            pageUrl: 'https://shop.example/checkout',
            uris: ['https://cdn.example/app.js'],
        });
    });

    test('sends one request per page URL when the location changes between entries', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://cdn.example/app.js']);
        Object.assign(globalThis.location, defaultLocation({ pathname: '/checkout/payment' }));
        env.observers[0].emit(['https://js.stripe.com/v3/stripe.js']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.deepEqual(
            uploads.map((u) => u.body),
            [
                { pageUrl: 'https://shop.example/checkout', uris: ['https://cdn.example/app.js'] },
                { pageUrl: 'https://shop.example/checkout/payment', uris: ['https://js.stripe.com/v3/stripe.js'] },
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

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
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

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.deepEqual(uploads[0].body, { uris: ['https://cdn.example/app.js'] });
    });

    test('honours resourceTypes option', async () => {
        const collector = new ResourceCollector({ ...validOptions, resourceTypes: ['css'] }).start();
        env.observers[0].emit(['https://cdn.example/app.js', 'https://cdn.example/style.css']);
        await collector.stop();

        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.deepEqual(uploads[0].body.uris, ['https://cdn.example/style.css']);
    });

    test('sends full batches eagerly and reuses the signed URL', async () => {
        const collector = new ResourceCollector({ ...validOptions, batchSize: 2 }).start();
        env.observers[0].emit(['https://a/1.js', 'https://a/2.js', 'https://a/3.js', 'https://a/4.js', 'https://a/5.js']);
        await collector.flush();

        const signed = env.fetchCalls.filter((c) => c.url.endsWith('/signed-url'));
        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.equal(signed.length, 1, 'signed URL fetched once and cached');
        assert.equal(uploads.length, 3);
        assert.deepEqual(uploads.map((u) => u.body.uris.length), [2, 2, 1]);
    });

    test('requests a fresh signed URL once the TTL has elapsed', async () => {
        const collector = new ResourceCollector({ ...validOptions, signedUrlTtlMs: 0 }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.flush();
        env.observers[0].emit(['https://a/2.js']);
        await collector.flush();
        await collector.stop();

        assert.equal(env.fetchCalls.filter((c) => c.url.endsWith('/signed-url')).length, 2);
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
        assert.equal(env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed').length, 1);
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
        assert.equal(env.fetchCalls.length, 1, 'signed URL requested as soon as the page is hidden');

        await collector.stop();
        const uploads = env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed');
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0].body.uris, ['https://a/1.js', 'https://a/2.js']);
    });

    test('flushes on pagehide', async () => {
        const collector = new ResourceCollector(validOptions).start();
        env.observers[0].emit(['https://a/1.js']);
        env.listeners.window.get('pagehide')();
        await collector.flush();
        assert.equal(env.fetchCalls.filter((c) => c.url === 'https://upload.example/signed').length, 1);
    });
});

describe('error handling', () => {
    let env;

    afterEach(() => {
        env?.restore();
    });

    test('refreshes the signed URL once when the upload is rejected', async () => {
        let uploadAttempts = 0;
        env = installBrowserGlobals({
            fetchImpl: (url) => {
                if (url.endsWith('/signed-url')) {
                    return jsonResponse({ signedUrl: 'https://upload.example/signed' });
                }
                uploadAttempts += 1;
                return jsonResponse({}, uploadAttempts === 1 ? 403 : 200);
            },
        });
        const errors = [];
        const collector = new ResourceCollector({ ...validOptions, onError: (e) => errors.push(e) }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(uploadAttempts, 2);
        assert.equal(env.fetchCalls.filter((c) => c.url.endsWith('/signed-url')).length, 2);
        assert.equal(errors.length, 0);
    });

    test('reports upload failures through onError', async () => {
        env = installBrowserGlobals({
            fetchImpl: (url) =>
                url.endsWith('/signed-url')
                    ? jsonResponse({ signedUrl: 'https://upload.example/signed' })
                    : jsonResponse({}, 500),
        });
        const errors = [];
        const collector = new ResourceCollector({ ...validOptions, onError: (e) => errors.push(e) }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /HTTP 500/);
    });

    test('reports a malformed signed URL response', async () => {
        env = installBrowserGlobals({ fetchImpl: () => jsonResponse({ nope: true }) });
        const errors = [];
        const collector = new ResourceCollector({ ...validOptions, onError: (e) => errors.push(e) }).start();
        env.observers[0].emit(['https://a/1.js']);
        await collector.stop();

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /signedUrl/);
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
