// Caches only the app shell. API responses are cached by the app (cleared on sign out).
const CACHE = 'sensorium-reader-shell-v22';
const SHELL = ['./', 'index.html', 'style.css', 'theme.js', 'config.js', 'app.js', 'manifest.json', 'icons/s7m-icon-32x32.png', 'icons/s7m-favicon-32x32.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Stale-while-revalidate for same-origin shell files; everything else goes to the network.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
    event.respondWith(
        caches.open(CACHE).then(async (cache) => {
            const cached = await cache.match(req, { ignoreSearch: true });
            const network = fetch(req).then((res) => {
                if (res.ok) cache.put(req, res.clone());
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
