# assetassure-resource-collector

Browser library that observes JS and CSS resources loaded by a page and reports
their URIs and types, together with the URL of the page that loaded them, to
the AssetAssure API in batches.

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
| `resourceTypes`   | no       | `['js']`  | Any of `'js'`, `'css'`. See [Classification](#classification).              |
| `batchSize`       | no       | `50`      | URIs per request. Keep bodies small: keepalive requests are capped at 64 KB. |
| `flushIntervalMs` | no       | `2000`    | Periodic flush interval. `0` disables the timer.                            |
| `signedUrlTtlMs`  | no       | `60000`   | How long a signed URL is reused before a fresh one is requested.            |
| `onError`         | no       |           | Called with an `Error` when a request fails. Errors are otherwise swallowed. |

### Behaviour

- Each batch is posted as
    `{ "pageUrl": "<origin + pathname>", "resources": [{ "uri": "...", "type": "js" | "css" }, ...] }`.
    The page URL is captured when the resource is observed, so single-page
    applications get one batch per route. Query string and fragment are
    stripped in the browser so session identifiers never leave the page.
    `pageUrl` is omitted when `location` is unavailable.
- Only resources not seen before on the current page URL are reported. The
    same resource is reported again when it is seen on another page.
- Pending URIs are sent when a full batch accumulates, on the flush interval,
    when the page is hidden, on `pagehide`, and on `stop()`.
- A rejected upload triggers one signed URL refresh and retry before the error
    is reported.
- `start()` is a no-op where `PerformanceObserver` is unavailable.

### Classification

Resources are classified from what the browser knows about them, not from the
URL alone, so scripts without a `.js` extension are reported too.

| Type  | Reported when                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------ |
| `js`  | `PerformanceResourceTiming.initiatorType` is `script` (any `<script src>`, for example `https://js.stripe.com/v3/`), or the URL path ends in `.js` / `.mjs` (dynamic `import()`, workers). |
| `css` | The URL path ends in `.css`. The `css` initiator type is deliberately not used: it marks fonts and images loaded *by* a stylesheet. |

Query string and fragment are ignored when checking the extension, so
`gtm.js?id=X` is a script. Fetch/XHR responses, images, fonts and iframes are
never reported.

## Development

```sh
npm install
npm run build   # emits dist/ (ESM, CommonJS, minified IIFE)
npm test        # node:test against src/
```

## Releasing

Releases are published to npm by GitHub Actions whenever a `v*` tag is pushed.
The workflow authenticates with npm trusted publishing, so no token is stored
in the repository, and every release carries a provenance attestation.

```sh
npm version patch   # or minor / major
git push --follow-tags
```

The tag must match the version in `package.json`; the workflow fails otherwise.
Build and tests run via `prepublishOnly` before anything is uploaded.
