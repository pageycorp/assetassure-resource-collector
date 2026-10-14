/**
 * Installs minimal browser globals so the collector can run under node:test.
 * Returns handles for driving the fake observer and inspecting fetch calls.
 */
export function installBrowserGlobals({ fetchImpl, location = defaultLocation() } = {}) {
    const previous = {};
    const listeners = { window: new Map(), document: new Map() };
    const observers = [];
    const fetchCalls = [];

    const fakeFetch = async (url, init) => {
        fetchCalls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
        if (fetchImpl) {
            return fetchImpl(url, init, fetchCalls.length);
        }
        return jsonResponse({ status: 'ok' });
    };

    class FakePerformanceObserver {
        constructor(callback) {
            this.callback = callback;
            this.disconnected = false;
            observers.push(this);
        }
        observe() {}
        disconnect() {
            this.disconnected = true;
        }
        /**
         * Emits resource timing entries. Each item is either a URL string or a
         * `{ name, initiatorType }` object. Strings ending in `.js` default to
         * initiator type `script` and `.css` to `link`, matching what a browser
         * reports for `<script src>` and `<link rel="stylesheet">`; anything else
         * defaults to `other`.
         */
        emit(items) {
            this.callback({ getEntries: () => items.map(toEntry) });
        }
    }

    const makeTarget = (map) => ({
        addEventListener: (type, fn) => map.set(type, fn),
        removeEventListener: (type) => map.delete(type),
    });

    const fakeDocument = { ...makeTarget(listeners.document), visibilityState: 'visible' };

    const globals = {
        PerformanceObserver: FakePerformanceObserver,
        fetch: fakeFetch,
        window: makeTarget(listeners.window),
        document: fakeDocument,
    };

    if (location !== null) {
        globals.location = location;
    }

    for (const [key, value] of Object.entries(globals)) {
        previous[key] = globalThis[key];
        globalThis[key] = value;
    }

    if (location === null) {
        previous.location = globalThis.location;
        delete globalThis.location;
    }

    return {
        observers,
        fetchCalls,
        listeners,
        document: fakeDocument,
        location: globalThis.location,
        restore() {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete globalThis[key];
                } else {
                    globalThis[key] = value;
                }
            }
        },
    };
}

function toEntry(item) {
    if (typeof item !== 'string') {
        return item;
    }

    const path = item.split(/[?#]/)[0];
    const initiatorType = /\.js$/i.test(path) ? 'script' : /\.css$/i.test(path) ? 'link' : 'other';

    return { name: item, initiatorType };
}

/**
 * Returns the URIs posted in an upload, in order.
 */
export function urisOf(upload) {
    return upload.body.resources.map((resource) => resource.uri);
}

/**
 * A fake `location` for a page with a query string and fragment, so tests can
 * assert both are stripped from the reported page URL.
 */
export function defaultLocation({ origin = 'https://shop.example', pathname = '/checkout' } = {}) {
    return {
        origin,
        pathname,
        search: '?session=secret',
        hash: '#payment',
        href: `${origin}${pathname}?session=secret#payment`,
    };
}

export function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Where every batch is posted for `validOptions`. */
export const CHECK_ASSETS_URL = 'https://api.acme.assetassure.io/check-assets';

export const validOptions = Object.freeze({
    publicToken: 'pk_test',
    apiDomain: 'api.acme.assetassure.io',
    flushIntervalMs: 0,
});
