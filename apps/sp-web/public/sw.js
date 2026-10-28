/*
 * Stashboard's service worker: makes the app installable and lets it open
 * without a connection.
 *
 * It keeps only the app itself (index.html, the hashed scripts and styles,
 * fonts and icons). It never touches /api: no scene data, pictures, video or
 * anything about you is stored by it. Requests it doesn't handle go to the
 * network exactly as if it weren't here.
 */
const SHELL_CACHE = 'stashboard-shell-v1';
const ASSET_CACHE = 'stashboard-assets-v1';
const KEEP = [SHELL_CACHE, ASSET_CACHE];
/** Old releases' bundles are dropped past this many files, oldest first. */
const MAX_ASSETS = 250;
/** main-WUR5SREH.js, media/primeicons-4GST5W3O.woff2: a new release gets new names. */
const HASHED = /-[A-Z0-9]{8}\.[a-z0-9]+$/;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('stashboard-') && !KEEP.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }
  if (HASHED.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isAppFile(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/** The app's own unhashed files: icons, the manifest, the theme script. */
function isAppFile(pathname) {
  return (
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/theme-boot.js' ||
    pathname === '/favicon.ico'
  );
}

/**
 * Always the newest app when online; the saved one when offline, or while
 * Stashboard restarts (a proxy in front answers 502/503 meanwhile).
 */
async function navigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_URL, response.clone());
    } else if (response.status >= 500) {
      return (await caches.match(SHELL_URL)) || response;
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_URL);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || fresh;
}

/** Saves the app and the files it starts with, so the first offline open works. */
async function precacheShell() {
  try {
    const response = await fetch(SHELL_URL, { cache: 'no-cache' });
    if (!response.ok) {
      return;
    }
    const html = await response.clone().text();
    const shell = await caches.open(SHELL_CACHE);
    await shell.put(SHELL_URL, response);
    const files = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], self.location.origin))
      .filter((url) => url.origin === self.location.origin && HASHED.test(url.pathname));
    const assets = await caches.open(ASSET_CACHE);
    await Promise.all(
      files.map((url) =>
        assets.match(url.href).then((hit) => (hit ? undefined : assets.add(url.href))),
      ),
    );
  } catch {
    // Offline or mid-deploy: the files are saved as the app loads them instead.
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ASSETS;
  for (let index = 0; index < extra; index += 1) {
    await cache.delete(keys[index]);
  }
}
