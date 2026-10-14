const PATH_EXTENSION_PATTERNS = Object.freeze({
    js: /\.m?js$/i,
    css: /\.css$/i,
});

/**
 * One classifier per resource type. Each receives a `PerformanceResourceTiming`
 * entry and the URL path (no query string or fragment) and returns whether the
 * entry is a resource of that type.
 *
 * Scripts are recognised from `initiatorType === 'script'`, which the browser
 * sets for every `<script src>` regardless of URL shape, so extension-less
 * scripts such as `https://js.stripe.com/v3/` are reported. The `.js`/`.mjs`
 * extension is kept as a fallback for dynamic `import()` and workers, which some
 * engines report with initiator type `other`.
 *
 * Stylesheets are recognised from the `.css` extension only. The `css`
 * initiator type marks resources loaded *by* a stylesheet (fonts, images), not
 * the stylesheet itself, so it must not be used here.
 */
const RESOURCE_TYPE_CLASSIFIERS = Object.freeze({
    js: (entry, path) => entry.initiatorType === 'script' || PATH_EXTENSION_PATTERNS.js.test(path),
    css: (entry, path) => PATH_EXTENSION_PATTERNS.css.test(path),
});

const API_DOMAIN_PATTERN = /^api\.[a-z0-9.-]+\.assetassure\.io$/i;
const CHECK_ASSETS_PATH = '/check-assets';

const DEFAULTS = Object.freeze({
    resourceTypes: ['js'],
    batchSize: 50,
    flushIntervalMs: 2000,
    onError: null,
});

/**
 * Observes resources loaded by the current page and reports their URIs and
 * types to the AssetAssure API in batches, one batch per page URL so the API
 * can record which page loaded which resource. The page must be served from
 * one of the payment page domains configured for the tenancy: the API refuses
 * any other page.
 *
 * @example
 * const collector = new ResourceCollector({
 *   publicToken: 'pk_live_...',
 *   apiDomain: 'api.acme.assetassure.io',
 * });
 * collector.start();
 */
export class ResourceCollector {
    static RESOURCE_TYPES = Object.freeze(Object.keys(RESOURCE_TYPE_CLASSIFIERS));

    #publicToken;
    #checkAssetsEndpoint;
    #classifiers;
    #batchSize;
    #flushIntervalMs;
    #onError;

    #seen = new Set();
    #pending = [];
    #observer = null;
    #intervalId = null;
    #inFlight = new Set();

    /**
     * @param {object} options
     * @param {string} options.publicToken   Public API token.
     * @param {string} options.apiDomain     Must match `api.<subdomain>.assetassure.io`.
     * @param {Array<'js'|'css'>} [options.resourceTypes=['js']]
     * @param {number} [options.batchSize=50]
     * @param {number} [options.flushIntervalMs=2000]
     * @param {(error: Error) => void} [options.onError]  Called when a request fails. Errors are otherwise swallowed.
     */
    constructor(options = {}) {
        const {
            publicToken,
            apiDomain,
            resourceTypes = DEFAULTS.resourceTypes,
            batchSize = DEFAULTS.batchSize,
            flushIntervalMs = DEFAULTS.flushIntervalMs,
            onError = DEFAULTS.onError,
        } = options;

        if (typeof publicToken !== 'string' || publicToken.length === 0) {
            throw new TypeError('ResourceCollector: publicToken is required');
        }

        if (typeof apiDomain !== 'string' || !API_DOMAIN_PATTERN.test(apiDomain)) {
            throw new TypeError('ResourceCollector: apiDomain must match "api.<subdomain>.assetassure.io"');
        }

        if (!Array.isArray(resourceTypes) || resourceTypes.length === 0) {
            throw new TypeError('ResourceCollector: resourceTypes must be a non-empty array');
        }

        const unknown = resourceTypes.filter((type) => !(type in RESOURCE_TYPE_CLASSIFIERS));
        if (unknown.length > 0) {
            throw new TypeError(
                `ResourceCollector: unknown resourceTypes ${JSON.stringify(unknown)}; expected one of ${JSON.stringify(ResourceCollector.RESOURCE_TYPES)}`,
            );
        }

        if (!Number.isInteger(batchSize) || batchSize < 1) {
            throw new TypeError('ResourceCollector: batchSize must be a positive integer');
        }

        if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
            throw new TypeError('ResourceCollector: flushIntervalMs must be a non-negative number');
        }

        if (onError !== null && typeof onError !== 'function') {
            throw new TypeError('ResourceCollector: onError must be a function');
        }

        this.#publicToken = publicToken;
        this.#checkAssetsEndpoint = `https://${apiDomain}${CHECK_ASSETS_PATH}`;
        this.#classifiers = resourceTypes.map((type) => [type, RESOURCE_TYPE_CLASSIFIERS[type]]);
        this.#batchSize = batchSize;
        this.#flushIntervalMs = flushIntervalMs;
        this.#onError = onError;
    }

    /** Whether the collector is currently observing. */
    get running() {
        return this.#observer !== null;
    }

    /**
     * Begin observing resource timing entries. Safe to call more than once.
     * Does nothing in environments without `PerformanceObserver`.
     *
     * @returns {this}
     */
    start() {
        if (this.running || typeof PerformanceObserver === 'undefined') {
            return this;
        }

        this.#observer = new PerformanceObserver((list) => {
            this.#processEntries(list.getEntries());
        });

        this.#observer.observe({ type: 'resource', buffered: true });

        if (this.#flushIntervalMs > 0) {
            this.#intervalId = setInterval(() => {
                this.flush();
            }, this.#flushIntervalMs);
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', this.#handlePageHide);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.#handleVisibilityChange);
        }

        return this;
    }

    /**
     * Stop observing and flush anything still pending.
     *
     * @returns {Promise<void>} Resolves once the final flush has settled.
     */
    stop() {
        if (!this.running) {
            return Promise.resolve();
        }

        this.#observer.disconnect();
        this.#observer = null;

        if (this.#intervalId !== null) {
            clearInterval(this.#intervalId);
            this.#intervalId = null;
        }

        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this.#handlePageHide);
        }
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
        }

        return this.flush();
    }

    /**
     * Send any pending resources immediately.
     *
     * @returns {Promise<void>} Resolves once all in-flight requests have settled.
     */
    flush() {
        if (this.#pending.length > 0) {
            this.#drain(this.#pending.splice(0, this.#pending.length));
        }

        return Promise.allSettled(this.#inFlight).then(() => undefined);
    }

    #handlePageHide = () => {
        this.flush();
    };

    #handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            this.flush();
        }
    };

    #processEntries(entries) {
        const pageUrl = this.#currentPageUrl();

        for (const entry of entries) {
            const uri = entry.name;
            const seenKey = `${pageUrl}|${uri}`;

            if (this.#seen.has(seenKey)) {
                continue;
            }

            const type = this.#classify(entry);

            if (type === null) {
                continue;
            }

            this.#seen.add(seenKey);
            this.#pending.push({ uri, type, pageUrl });
        }

        while (this.#pending.length >= this.#batchSize) {
            this.#drain(this.#pending.splice(0, this.#batchSize));
        }
    }

    /**
     * Returns the configured resource type matching the entry, or `null` when
     * the entry is not a resource this collector reports.
     *
     * @param {PerformanceResourceTiming} entry
     * @returns {string|null}
     */
    #classify(entry) {
        const path = ResourceCollector.#pathOf(entry.name);

        for (const [type, classifier] of this.#classifiers) {
            if (classifier(entry, path)) {
                return type;
            }
        }

        return null;
    }

    /**
     * The URL path without query string or fragment, so `gtm.js?id=X` and
     * `app.js#hash` are classified by their extension.
     *
     * @param {string} uri
     * @returns {string}
     */
    static #pathOf(uri) {
        const end = uri.search(/[?#]/);

        return end === -1 ? uri : uri.slice(0, end);
    }

    /**
     * The page currently loading resources, without query string or fragment so
     * that session identifiers or tokens never leave the browser.
     *
     * @returns {string|null}
     */
    #currentPageUrl() {
        if (typeof location === 'undefined' || typeof location.origin !== 'string' || typeof location.pathname !== 'string') {
            return null;
        }

        return `${location.origin}${location.pathname}`;
    }

    /**
     * Sends the given pending items, one request per page URL.
     *
     * @param {Array<{uri: string, type: string, pageUrl: string|null}>} items
     */
    #drain(items) {
        const groups = new Map();

        for (const { uri, type, pageUrl } of items) {
            if (!groups.has(pageUrl)) {
                groups.set(pageUrl, []);
            }
            groups.get(pageUrl).push({ uri, type });
        }

        for (const [pageUrl, resources] of groups) {
            this.#send(resources, pageUrl);
        }
    }

    #send(resources, pageUrl) {
        const request = this.#postResources(resources, pageUrl)
            .catch((error) => {
                this.#reportError(error);
            })
            .finally(() => {
                this.#inFlight.delete(request);
            });

        this.#inFlight.add(request);
    }

    /**
     * One POST straight to /check-assets: the public token in the Authorization
     * header is the only credential, there is no signed URL round trip.
     */
    async #postResources(resources, pageUrl) {
        const body = JSON.stringify(pageUrl === null ? { resources } : { pageUrl, resources });
        const response = await fetch(this.#checkAssetsEndpoint, this.#requestInit(body));

        if (!response.ok) {
            throw new Error(`ResourceCollector: asset check failed with HTTP ${response.status}`);
        }
    }

    #requestInit(body) {
        return {
            method: 'POST',
            keepalive: true,
            headers: {
                Accept: 'application/json',
                Authorization: `Basic ${btoa(`${this.#publicToken}:`)}`,
                'Content-Type': 'application/json',
            },
            body,
        };
    }

    #reportError(error) {
        if (this.#onError === null) {
            return;
        }

        try {
            this.#onError(error);
        } catch {
            // Never let a consumer's error handler break the host page.
        }
    }
}

export default ResourceCollector;
