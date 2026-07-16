# Netlify deploy fix

The previous ZIP placed `secure-catalog.mjs` and `static-catalog.json` directly inside `netlify/functions`.
Netlify tried to deploy `secure-catalog.mjs` as if it were a serverless function even though it is only a shared helper module. The deploy log therefore reported:

`Failed to create function: secure-catalog`

This version moves shared files to `netlify/shared`, keeps only real request handlers in `netlify/functions`, and enables the esbuild function bundler.

## What to do

1. Replace the repository contents with this ZIP.
2. Keep your existing Netlify environment variables, including `FIREBASE_SERVICE_ACCOUNT_BASE64`.
3. Trigger a fresh deploy. Use **Clear cache and deploy site** rather than retrying the old failed deploy.

Do not place helper-only `.mjs` files inside `netlify/functions` unless they export a real Netlify request handler.
