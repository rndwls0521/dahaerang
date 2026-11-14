// 오프라인에서도 앱이 열리도록 앱 파일을 캐시합니다.
// 앱을 수정한 뒤 배포할 때는 VERSION 숫자를 올려주세요.
const VERSION = 'dahaerang-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './js/app.js', './js/db.js', './js/icons.js',
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
  // 폰트는 캐시 우선
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return;
  // 앱 파일: 네트워크 우선, 실패하면 캐시 (업데이트가 바로 반영되도록)
  e.respondWith(
    fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
