# assetassure-resource-collector

Browser library that observes JS and CSS resources loaded by a page and reports
their URIs and types, together with the URL of the page that loaded them, to
the AssetAssure API in batches. The page must be served from one of the payment
page domains listed under API > Settings of the tenancy: the API refuses a batch
reporting any other page.

## Install

```sh
npm install assetassure-resource-collector
```

Or load the minified build from a CDN. It exposes the class as
`window.AssetAssureResourceCollector`:

Pin the exact version and add the `integrity` attribute shown on the API >
Settings page of your tenancy, so the browser refuses to run a modified file:

```html
<script
    src="https://cdn.jsdelivr.net/npm/assetassure-resource-collector@0.4.0/dist/assetassure-resource-collector.min.js"
    integrity="sha384-..."
    crossorigin="anonymous"
></script>
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
| `onError`         | no       |           | Called with an `Error` when a request fails. Errors are otherwise swallowed. |

### Behaviour

- Each batch is posted straight to `https://<apiDomain>/check-assets` as
    `{ "pageUrl": "<origin + pathname>", "resources": [{ "uri": "...", "type": "js" | "css" }, ...] }`,
    with the public token as Basic auth. The page URL is captured when the
    resource is observed, so single-page applications get one batch per route.
    Query string and fragment are stripped in the browser so session
    identifiers never leave the page. `pageUrl` is omitted when `location` is
    unavailable, in which case the API rejects the batch: it needs the page to
    check it against the payment page domains of the tenancy.
- Only resources not seen before on the current page URL are reported. The
    same resource is reported again when it is seen on another page.
- Pending URIs are sent when a full batch accumulates, on the flush interval,
    when the page is hidden, on `pagehide`, and on `stop()`.
- A rejected upload (for example `403` when the page is not on an allowed
    payment page domain) is reported through `onError` and not retried.
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
