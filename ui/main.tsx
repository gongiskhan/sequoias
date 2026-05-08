import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.js';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sequoias] service worker registration failed:', err);
    });
  });
}
