export type ResourceType = 'js' | 'css';

export interface ResourceCollectorOptions {
    /** Public API token. */
    publicToken: string;
    /** Must match `api.<subdomain>.assetassure.io`. */
    apiDomain: string;
    /** Resource kinds to report. Defaults to `['js']`. */
    resourceTypes?: ResourceType[];
    /** URIs per request. Defaults to 50. */
    batchSize?: number;
    /** Periodic flush interval in milliseconds. `0` disables the timer. Defaults to 2000. */
    flushIntervalMs?: number;
    /** How long a signed URL is reused before a fresh one is requested. Defaults to 60000. */
    signedUrlTtlMs?: number;
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

    /** Send any pending URIs immediately. */
    flush(): Promise<void>;
}

export default ResourceCollector;
