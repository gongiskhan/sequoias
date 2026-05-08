// Sequoias service worker — minimal, just enough for installability.
// Sequoias is a local dashboard, so we don't try to cache anything aggressively.
// This SW exists so browsers will surface the install prompt.

const VERSION = 'sequoias-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API or WebSocket routes — pass straight to the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/_hook')) {
    return;
  }
  // Network-first for everything else; if offline, do nothing (let the browser error normally).
  event.respondWith(
    fetch(event.request).catch(() => new Response('', { status: 504, statusText: 'Offline' })),
  );
});
