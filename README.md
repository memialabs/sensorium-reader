# Sensorium Reader

A mobile-friendly PWA for reading Sensorium collation newsletters. It is a static site (no build step) that talks to a Sensorium server over its HTTP API using an API key.

## Host it

Copy this folder to any static host that serves over HTTPS (Netlify, Cloudflare Pages, GitHub Pages, S3 + CDN, nginx). HTTPS is required for the service worker and installing to a home screen; `localhost` is exempt.

Quick local try:

    python3 -m http.server 8080

## Configure (optional)

`config.js` ships preconfigured for `https://www.s7m.net` and a local server at `http://127.0.0.1:5000`. To point the Reader at your own Sensorium server, edit it:

    window.READER_CONFIG = {
        presets: ['https://sensorium.example.com'],
        defaultBase: 'https://sensorium.example.com',
    };

Set `presets: []` and `defaultBase: ''` to have users type their server URL on the sign-in screen. "Custom…" is always available in the dropdown.

## Sign in

1. In Sensorium, create an API key (API Tokens). A read-only key with collations, links, stories, sections and analysis scopes is enough.
2. Open the Reader, enter the server URL and paste the key.

By default, the API key and saved newsletters use sessionStorage and last only for the browser tab's session. Select **Remember this device** to keep them in localStorage across browser restarts. Only use that option on a trusted device. Sign out clears both storage areas and cancels pending requests. Changing credentials clears old content and creates a separate cache namespace. Previously saved credentials require a fresh sign-in after this update.

Use narrowly scoped, read-only API keys with an expiry, and revoke keys in Sensorium when no longer needed. Server URLs must use HTTPS; HTTP is allowed only for localhost, 127.0.0.1, and [::1].

## Sensorium server requirement: CORS

The Reader runs on a different origin from the API, so the Sensorium server must allow cross-origin calls. Set this environment variable on the server and restart:

    API_CORS_ORIGINS=https://reader.example.com

Or list specific origins, comma-separated: `API_CORS_ORIGINS=https://reader.example.com,http://localhost:8080`.

Use explicit production origins. Requests explicitly use `credentials: "omit"`, authenticating with the bearer token rather than cookies. CORS is not a substitute for server-side authentication and scope checks.

## Updating

When you change any shell file (`index.html`, `app.js`, `style.css`, `theme.js`, `config.js`), bump `CACHE` in `service-worker.js` so installed copies pick up the update.

## Security headers

The included `_headers` file configures CSP, clickjacking protection, MIME sniffing protection, and referrer policy on Netlify and Cloudflare Pages. Include it in the published directory. For nginx, S3/CDN, or another host, configure equivalent HTTP response headers using that file as the reference; GitHub Pages does not apply `_headers` files. Verify the deployed document's response headers before production use. `frame-ancestors` cannot be enforced by an HTML meta tag.

The CSP allows HTTPS API servers to support custom connections. For a deployment with a fixed server, narrow `connect-src` in both `_headers` and `index.html` to that API origin (and `'self'` if needed). Remove localhost exceptions in production if local connections are unnecessary. Serve the Reader on a dedicated origin where possible, since scripts sharing an origin also share access to browser storage.
