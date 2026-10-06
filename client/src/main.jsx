import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>,
);

// Keep installed copies (home-screen apps) from sticking to an old build: a new service worker takes
// over immediately (skipWaiting + clients.claim in sw.js) and we reload once.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => reg.update().catch(() => {})).catch(() => {});
  });
}
