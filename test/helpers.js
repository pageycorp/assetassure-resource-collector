/**
 * Installs minimal browser globals so the collector can run under node:test.
 * Returns handles for driving the fake observer and inspecting fetch calls.
 */
export function installBrowserGlobals({ fetchImpl } = {}) {
    const previous = {};
    const listeners = { window: new Map(), document: new Map() };
    const observers = [];
    const fetchCalls = [];

    const fakeFetch = async (url, init) => {
        fetchCalls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
        if (fetchImpl) {
            return fetchImpl(url, init, fetchCalls.length);
        }
        if (url.endsWith('/signed-url')) {
            return jsonResponse({ signedUrl: 'https://upload.example/signed' });
        }
        return jsonResponse({});
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
        emit(names) {
            this.callback({ getEntries: () => names.map((name) => ({ name })) });
        }
    }

    const makeTarget = (map) => ({
        addEventListener: (type, fn) => map.set(type, fn),
        removeEventListener: (type) => map.delete(type),
    });

    const fakeDocument = { ...makeTarget(listeners.document), visibilityState: 'visible' };

    for (const [key, value] of Object.entries({
        PerformanceObserver: FakePerformanceObserver,
        fetch: fakeFetch,
        window: makeTarget(listeners.window),
        document: fakeDocument,
    })) {
        previous[key] = globalThis[key];
        globalThis[key] = value;
    }

    return {
        observers,
        fetchCalls,
        listeners,
        document: fakeDocument,
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

export function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export const validOptions = Object.freeze({
    publicToken: 'pk_test',
    apiDomain: 'api.acme.assetassure.io',
    flushIntervalMs: 0,
});
