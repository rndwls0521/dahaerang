// 오프라인에서도 앱이 열리도록 앱 파일을 캐시합니다.
// 앱을 수정한 뒤 배포할 때는 VERSION 숫자를 올려주세요.
const VERSION = 'dahaerang-v7';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './js/app.js', './js/db.js', './js/icons.js', './js/sync.js', './js/config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 폰트 · 버전이 고정된 라이브러리(CDN)는 캐시 우선
  if (url.hostname.includes('fonts.g') || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return; // Supabase 등 서버 요청은 건드리지 않음
  if (url.pathname.endsWith('/inbox.json')) return;
  // 앱 파일: 항상 서버에 새 버전이 있는지 확인(no-cache), 오프라인이면 캐시
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
