// App shell cache (web panel). API calls always go to the network.
const CACHE = 'smart-notes-v4.4';
const SHELL = ['./', 'index.html', 'app.js', 'core.js', 'store.js', 'style.css', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'fonts/Vazirmatn-Regular.woff2', 'fonts/Vazirmatn-Bold.woff2'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api') || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
