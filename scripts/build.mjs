import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const entry = 'src/index.js';
const target = ['es2017', 'chrome64', 'firefox62', 'safari12', 'edge79'];

await rm('dist', { recursive: true, force: true });

await Promise.all([
    // ESM for bundlers and modern Node.
    build({
        entryPoints: [entry],
        outfile: 'dist/index.js',
        format: 'esm',
        target,
        bundle: true,
        sourcemap: true,
    }),
    // CommonJS for `require()`.
    build({
        entryPoints: [entry],
        outfile: 'dist/index.cjs',
        format: 'cjs',
        target,
        bundle: true,
        sourcemap: true,
    }),
    // Minified IIFE for <script> tags. Exposes the class itself as the global,
    // not the module namespace, so `new AssetAssureResourceCollector(...)` works.
    build({
        entryPoints: [entry],
        outfile: 'dist/assetassure-resource-collector.min.js',
        format: 'iife',
        globalName: 'AssetAssureResourceCollector',
        footer: { js: 'AssetAssureResourceCollector = AssetAssureResourceCollector.default;' },
        target,
        bundle: true,
        minify: true,
        keepNames: true,
        sourcemap: true,
    }),
]);
