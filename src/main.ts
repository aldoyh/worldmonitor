import './styles/base-layer.css';
import './styles/happy-theme.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Sentry from '@sentry/browser';
import { inject } from '@vercel/analytics';
import { App } from './App';
import { ObsOverlay } from './components/ObsOverlay';

// Initialize Sentry error tracking (early as possible)
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
  release: `worldmonitor@${__APP_VERSION__}`,
  environment: location.hostname === 'worldmonitor.app' ? 'production'
    : location.hostname.includes('vercel.app') ? 'preview'
    : 'development',
  enabled: Boolean(import.meta.env.VITE_SENTRY_DSN) && !location.hostname.startsWith('localhost') && !('__TAURI_INTERNALS__' in window),
  sendDefaultPii: true,
  tracesSampleRate: 0.1,
  ignoreErrors: [
    // ... existing error patterns ...
  ],
  beforeSend(event) {
    // ... existing error filtering logic ...
    return event;
  },
});

// Initialize Vercel Analytics
inject();

// Initialize dynamic meta tags for sharing
initMetaTags();

// In desktop mode, route /api/* calls to the local Tauri sidecar backend.
installRuntimeFetchPatch();
// In web production, route RPC calls through api.worldmonitor.app (Cloudflare edge).
installWebApiRedirect();
loadDesktopSecrets().catch(() => {});

// Apply stored theme preference before app initialization (safety net for inline script)
applyStoredTheme();

// Set data-variant on <html> so CSS theme overrides activate
if (SITE_VARIANT && SITE_VARIANT !== 'full') {
  document.documentElement.dataset.variant = SITE_VARIANT;

  // Swap favicons to variant-specific versions before browser finishes fetching defaults
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
    link.href = link.href
      .replace(/\/favico\/favicon/g, `/favico/${SITE_VARIANT}/favicon`)
      .replace(/\/favico\/apple-touch-icon/g, `/favico/${SITE_VARIANT}/apple-touch-icon`);
  });
}

// Remove no-transition class after first paint to enable smooth theme transitions
requestAnimationFrame(() => {
  document.documentElement.classList.remove('no-transition');
});

// Clear stale settings-open flag (survives ungraceful shutdown)
localStorage.removeItem('wm-settings-open');

// Standalone windows: ?settings=1 = panel display settings, ?live-channels=1 = channel management
// Both need i18n initialized so t() does not return undefined.
const urlParams = new URL(location.href).searchParams;
if (urlParams.get('settings') === '1') {
  void Promise.all([import('./services/i18n'), import('./settings-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initSettingsWindow();
    }
  );
} else if (urlParams.get('live-channels') === '1') {
  void Promise.all([import('./services/i18n'), import('./live-channels-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initLiveChannelsWindow();
    }
  );
} else {
  const app = new App('app');
  app
    .init()
    .then(() => {
      // Initialize OBS overlay
      const obsOverlay = new ObsOverlay();
      document.body.appendChild(obsOverlay.element);

      // Make the overlay draggable
      let isDragging = false;
      let offsetX: number, offsetY: number;

      obsOverlay.element.addEventListener('mousedown', (e) => {
        isDragging = true;
        offsetX = e.clientX - obsOverlay.element.getBoundingClientRect().left;
        offsetY = e.clientY - obsOverlay.element.getBoundingClientRect().top;
        obsOverlay.element.style.cursor = 'grabbing';
        e.stopPropagation();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        obsOverlay.element.style.left = `${e.clientX - offsetX}px`;
        obsOverlay.element.style.top = `${e.clientY - offsetY}px`;
        obsOverlay.element.style.position = 'fixed';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        obsOverlay.element.style.cursor = 'default';
      });

      // Add keyboard shortcut to toggle overlay visibility (Ctrl+Shift+O)
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'o') {
          obsOverlay.toggleVisibility();
        }
      });

      clearChunkReloadGuard(chunkReloadStorageKey);
    })
    .catch(console.error);
}

// Debug helpers for geo-convergence testing (remove in production)
(window as unknown as Record<string, unknown>).geoDebug = {
  cells: debugGetCells,
  count: getCellCount,
};

// Beta mode toggle: type `beta=true` / `beta=false` in console
Object.defineProperty(window, 'beta', {
  get() {
    const on = localStorage.getItem('worldmonitor-beta-mode') === 'true';
    console.log(`[Beta] ${on ? 'ON' : 'OFF'}`);
    return on;
  },
  set(v: boolean) {
    if (v) localStorage.setItem('worldmonitor-beta-mode', 'true');
    else localStorage.removeItem('worldmonitor-beta-mode');
    location.reload();
  },
});

// Suppress native WKWebView context menu in Tauri — allows custom JS context menus
if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    // Allow native menu on text inputs/textareas for copy/paste
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    e.preventDefault();
  });
}

if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window) && 'serviceWorker' in navigator) {
  // One-time nuke: clear stale SWs and caches from old deploys, then re-register fresh.
  // Safe to remove after 2026-03-20 when all users have cycled through.
  const nukeKey = 'wm-sw-nuked-v2';
  let alreadyNuked = false;
  try { alreadyNuked = !!localStorage.getItem(nukeKey); } catch { /* private browsing */ }
  if (!alreadyNuked) {
    try { localStorage.setItem(nukeKey, '1'); } catch { /* best effort */ }
    navigator.serviceWorker.getRegistrations().then(async (regs) => {
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      console.log('[PWA] Nuked stale service workers and caches');
      window.location.reload();
    });
  } else {
    // Auto-reload when a new SW takes control (fixes stale HTML after deploys)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((registration) => {
        console.log('[PWA] Service worker registered');
        const swUpdateInterval = setInterval(async () => {
          if (!navigator.onLine) return;
          try { await registration.update(); } catch {}
        }, 5 * 60 * 1000);
        (window as unknown as Record<string, unknown>).__swUpdateInterval = swUpdateInterval;
      })
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
  }
}
