export type ResourceType = 'js' | 'css';

/** One item of the `resources` array posted to the API. */
export interface ReportedResource {
    uri: string;
    type: ResourceType;
}

export interface ResourceCollectorOptions {
    /** Public API token. */
    publicToken: string;
    /** Must match `api.<subdomain>.assetassure.io`. */
    apiDomain: string;
    /**
     * Resource kinds to report. Defaults to `['js']`.
     * `js` matches `initiatorType === 'script'` or a `.js`/`.mjs` path; `css` matches a `.css` path.
     */
    resourceTypes?: ResourceType[];
    /** URIs per request. Defaults to 50. */
    batchSize?: number;
    /** Periodic flush interval in milliseconds. `0` disables the timer. Defaults to 2000. */
    flushIntervalMs?: number;
    /** Called when a request fails. Errors are otherwise swallowed. */
    onError?: (error: Error) => void;
}

export declare class ResourceCollector {
    static readonly RESOURCE_TYPES: readonly ResourceType[];

    constructor(options: ResourceCollectorOptions);

    /** Whether the collector is currently observing. */
    readonly running: boolean;

    /** Begin observing. No-op if already running or `PerformanceObserver` is unavailable. */
    start(): this;

    /** Stop observing and flush anything still pending. */
    stop(): Promise<void>;

    /** Send any pending resources immediately, one request per page URL. */
    flush(): Promise<void>;
}

export default ResourceCollector;
