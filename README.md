# assetassure-resource-collector

Browser library that observes JS and CSS resources loaded by a page and reports
their URIs to the AssetAssure API in batches.

## Install

```sh
npm install assetassure-resource-collector
```

Or load the minified build from a CDN. It exposes the class as
`window.AssetAssureResourceCollector`:

```html
<script src="https://unpkg.com/assetassure-resource-collector"></script>
<script>
    new AssetAssureResourceCollector({
        publicToken: 'your-public-token',
        apiDomain: 'api.example.assetassure.io',
    }).start();
</script>
```

## Usage

```js
import { ResourceCollector } from 'assetassure-resource-collector';

const collector = new ResourceCollector({
    publicToken: 'your-public-token',
    apiDomain: 'api.example.assetassure.io',
    resourceTypes: ['js', 'css'],
    onError: (error) => console.warn(error),
});

collector.start();

// Later, to disconnect the observer and flush anything still pending:
await collector.stop();
```

CommonJS is supported too:

```js
const { ResourceCollector } = require('assetassure-resource-collector');
```

### Options

| Option            | Required | Default   | Description                                                                 |
| ----------------- | -------- | --------- | --------------------------------------------------------------------------- |
| `publicToken`     | yes      |           | Public token used for Basic auth against the AssetAssure API.               |
| `apiDomain`       | yes      |           | Must match `api.<subdomain>.assetassure.io`.                                |
| `resourceTypes`   | no       | `['js']`  | Any of `'js'`, `'css'`.                                                     |
| `batchSize`       | no       | `50`      | URIs per request. Keep bodies small: keepalive requests are capped at 64 KB. |
| `flushIntervalMs` | no       | `2000`    | Periodic flush interval. `0` disables the timer.                            |
| `signedUrlTtlMs`  | no       | `60000`   | How long a signed URL is reused before a fresh one is requested.            |
| `onError`         | no       |           | Called with an `Error` when a request fails. Errors are otherwise swallowed. |

### Behaviour

- Only resources not seen before on the page are reported.
- Pending URIs are sent when a full batch accumulates, on the flush interval,
    when the page is hidden, on `pagehide`, and on `stop()`.
- A rejected upload triggers one signed URL refresh and retry before the error
    is reported.
- `start()` is a no-op where `PerformanceObserver` is unavailable.

## Development

```sh
npm install
npm run build   # emits dist/ (ESM, CommonJS, minified IIFE)
npm test        # node:test against src/
```

Publishing runs build and tests automatically via `prepublishOnly`.
