/* Offline shell for vaultless.
 *
 * Two reasons this exists, and neither is speed.
 *
 * A password manager that needs the network to hand you a password is not much
 * of one: derivation is entirely local, so the only thing standing between a
 * user on a plane and their password was the fetch for the page itself.
 *
 * The second is subtler. Without a cache, every visit re-fetches the derivation
 * code from the host, so the code someone reviewed last week is only the code
 * that runs today if the host is still honest on the day they use it. A cached
 * shell pins it between deliberate updates.
 *
 * Rules, in order of importance:
 *
 *  - Only same-origin GETs are touched. Everything else falls straight through.
 *  - The firmware image and its manifest are NEVER cached. They are versioned
 *    by CI and flashed onto hardware; serving a stale one silently reflashes the
 *    previous build, which is exactly what the cache-busting in the workflow
 *    exists to prevent.
 *  - The shell is cache-first, because pinning is the point. Everything else is
 *    network-first with the cache as a fallback.
 *  - No skipWaiting. A new worker takes over on the next visit rather than
 *    swapping the crypto out from under a page mid-derivation.
 */

/* Bump on every shell change. The shell is served cache-first, so a stale
 * VERSION means returning visitors keep the previous index.html and styles.css
 * indefinitely — the activate handler drops old caches only once this differs. */
const VERSION = 'vaultless-v2';

/* The app shell: markup, the four modules, the vendored crypto, fonts, icons.
 * esp-web-tools is deliberately absent — it is a large graph that only the
 * flashing branch loads, and it is useless without a device plugged in anyway. */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ui.js',
  './sheet.js',
  './recovery.js',
  './vendor/noble-bundle.js',
  './vendor/qr-bundle.js',
  './vendor/fonts/fonts.css',
  './manifest.json',
  './favicon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* Never served from cache: a stale manifest or image would reflash a device
 * with the previous firmware build. */
const NEVER_CACHE = [/\/firmware_merged\.bin/, /\/esp-manifest\.json/];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* Added one at a time rather than with addAll, which rejects the whole
     * install if any single entry 404s. A missing icon should not cost the user
     * their offline app. */
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch { /* skip this one; the fetch handler will fall back to network */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n === VERSION ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // nothing cross-origin, ever
  if (NEVER_CACHE.some(re => re.test(url.pathname))) return;

  const isShell = SHELL.some(p => new URL(p, self.location).pathname === url.pathname);

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);

    if (isShell) {
      // Cache-first: the pinned copy is the point.
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
    }

    try {
      const response = await fetch(request);
      // Only opaque-free, successful, basic responses are worth keeping.
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => { /* quota, private mode */ });
      }
      return response;
    } catch (err) {
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      // A navigation with no network and no cached copy still gets the shell.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
