/*
 * support.js — boot loader for every screen.
 *
 * Each screen starts with <script src="./support.js"></script>, the same tag Claude Design puts in
 * exported .dc.html files. So any screen you drop into this folder automatically gets:
 *   1. PWA plumbing: viewport, manifest, icons, service worker (installable + offline)
 *   2. Data: lib/db.js (IndexedDB), lib/content.js, lib/stats.js, lib/setup.js, lib/reminders.js,
 *      lib/quotes.js, loaded (and set up) before the screen renders
 *   3. The Design Component runtime (lib/dc-runtime.js) for pages that contain <x-dc>
 *   4. Navigation that saves first: links wait for pending writes, and Back/Close links go back
 *      in history (so the phone's back button and the in-app arrows agree)
 *   5. A 4.5-second splash with the logo when the app opens
 *
 * Globals for screens: db, content, stats, setup, reminders, quotes, nav. Plain .html pages should wait for
 * `appReady`.
 */
(function () {
  'use strict';

  const ROOT = new URL('../', document.currentScript.src).href; // the app folder
  const START = ROOT + 'screens/Home.dc.html';
  const head = document.head;

  function add(tag, props) {
    const el = Object.assign(document.createElement(tag), props);
    head.appendChild(el);
    return el;
  }
  function meta(name, content) {
    if (!head.querySelector('meta[name="' + name + '"]')) add('meta', { name, content });
  }

  // Keep the raw template (with its {{holes}}) hidden until the runtime has rendered it.
  add('style', { textContent: 'x-dc{display:none!important}' });
  // maximum-scale=1 stops iOS from zooming into small text fields when you tap them.
  meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  meta('theme-color', '#FFFFFF');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-title', 'Sadhana');
  meta('apple-mobile-web-app-status-bar-style', 'default');
  add('link', { rel: 'manifest', href: ROOT + 'manifest.webmanifest' });
  add('link', { rel: 'icon', href: ROOT + 'icons/favicon.png', type: 'image/png' });
  add('link', { rel: 'apple-touch-icon', href: ROOT + 'icons/apple-touch-icon.png' });
  add('link', { rel: 'stylesheet', href: ROOT + 'lib/pwa.css' });

  const splash = startSplash();

  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false; // run in the order they were added
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load ' + src));
      head.appendChild(s);
    });
  }

  const domReady = new Promise((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  });

  // ---------------------------------------------------------------- boot

  window.appReady = Promise.all(['lib/db.js', 'lib/content.js', 'lib/stats.js', 'lib/setup.js', 'lib/reminders.js', 'lib/quotes.js'].map((f) => load(ROOT + f)))
    .then(() => db.ready)
    .then(() => setup.run())
    .then(() => domReady)
    .then(() => document.querySelector('x-dc') && load(ROOT + 'lib/dc-runtime.js'))
    .then(() => {
      rerenderOnChange();
      addDevHandle();
      reminders.schedule();
      // Timers pause while the app is in the background; set them again when it comes back.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reminders.schedule(); });
    })
    .catch(showBootError);

  // The splash stays 4.5 seconds, longer if the screen isn't ready yet (8 at most).
  if (splash) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    Promise.race([Promise.all([wait(2500), window.appReady]), wait(8000)]).then(splash.hide);
  }

  // ---------------------------------------------------------------- splash

  // The logo on Isha orange when the app opens (once per session, not on every screen): the lotus
  // stays still while the snake spins around the middle of its coil. The two layers are
  // icons/splash-lotus.webp and icons/splash-snake.webp, the same size, stacked. They're drawn with
  // pseudo-elements on <html>, so the splash is there from the first frame, before the screen renders.
  function startSplash() {
    if (/\/Dev\.html$/.test(location.pathname)) return null;
    let first = false;
    try {
      first = !sessionStorage.getItem('sadhana-pwa.splashShown');
      sessionStorage.setItem('sadhana-pwa.splashShown', '1');
    } catch (err) { /* storage blocked: skip the splash rather than show it on every screen */ }
    if (!first) return null;
    const style = add('style', {
      textContent:
        'html{--pwa-splash-w:min(56vw,230px);--pwa-splash-h:calc(var(--pwa-splash-w)*1.2632);}' +
        'html::before,html::after{content:"";position:fixed;z-index:2147483646;transition:opacity .45s ease;}' +
        'html::before{top:0;right:0;bottom:0;left:0;background:#F37021 url("' + ROOT + 'icons/splash-lotus.webp") center/var(--pwa-splash-w) var(--pwa-splash-h) no-repeat;}' +
        'html::after{z-index:2147483647;left:50%;top:50%;width:var(--pwa-splash-w);height:var(--pwa-splash-h);' +
        'background:url("' + ROOT + 'icons/splash-snake.webp") center/100% 100% no-repeat;' +
        // 44.7% 59.47% is the middle of the coil in the image; the snake turns clockwise.
        'transform:translate(-50%,-50%);transform-origin:44.7% 59.47%;animation:pwa-splash-spin 2.4s linear infinite;}' +
        '@keyframes pwa-splash-spin{from{transform:translate(-50%,-50%) rotate(0deg);}to{transform:translate(-50%,-50%) rotate(360deg);}}' +
        'html.pwa-splash-out::before,html.pwa-splash-out::after{opacity:0;}' +
        '@media (prefers-reduced-motion:reduce){html::after{animation:none;}}',
    });
    return {
      hide() {
        document.documentElement.classList.add('pwa-splash-out');
        setTimeout(() => {
          style.remove();
          document.documentElement.classList.remove('pwa-splash-out');
        }, 500);
      },
    };
  }

  // Screens read `db` inside renderVals(). Whenever data changes, re-render every mounted component
  // so the screen always shows what's in the database.
  function rerenderOnChange() {
    db.on(() => {
      const registry = window.__dcRegistry;
      if (!registry) return;
      Object.values(registry).forEach((entry) => entry && entry.subs && entry.subs.forEach((fn) => fn()));
    });
  }

  // ---------------------------------------------------------------- navigation

  function cameFromApp() {
    try {
      return history.length > 1 && !!document.referrer && new URL(document.referrer).origin === location.origin;
    } catch (err) {
      return false;
    }
  }

  window.nav = {
    // Open another screen once pending writes are saved.
    go(href) {
      return db.flush().then(() => location.assign(new URL(href, location.href).href));
    },
    // Go back like a native back button; if this screen was opened directly, open `fallback`.
    back(fallback) {
      return db.flush().then(() => {
        if (cameFromApp()) history.back();
        else location.replace(new URL(fallback || START, location.href).href);
      });
    },
    // Query parameter of this screen, e.g. nav.param('p') on PracticeDetail.dc.html?p=isha
    param(name) {
      return new URLSearchParams(location.search).get(name);
    },
  };

  // Links: wait for the database, then navigate. Back/Close arrows (aria-label="Back"/"Close", or
  // any link with data-back) go back in history instead of stacking a new page.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    if (!window.db) return;
    e.preventDefault();
    const isBack = a.hasAttribute('data-back') || /^(back|close)$/i.test(a.getAttribute('aria-label') || '');
    if (isBack) nav.back(url.href);
    else nav.go(url.href);
  });

  // Coming back via the back/forward cache: refresh data that other screens may have changed.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && window.db) db.reload();
  });

  // ---------------------------------------------------------------- service worker

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(ROOT + 'sw.js').catch((err) => console.warn('[pwa] service worker not registered', err));
  }

  // ---------------------------------------------------------------- dev tools

  // A small handle on every screen that opens Dev.html (screen list + database viewer).
  // Hide it from Dev.html if it gets in the way.
  function addDevHandle() {
    if (db.get('dev.handle', true) === false || /\/Dev\.html$/.test(location.pathname)) return;
    const a = document.createElement('a');
    a.href = ROOT + 'screens/Dev.html';
    a.className = 'pwa-dev-handle';
    a.setAttribute('aria-label', 'Screens and data');
    a.innerHTML = '<span>Screens &amp; data</span>';
    document.body.appendChild(a);
  }

  function showBootError(err) {
    console.error('[pwa] boot failed', err);
    domReady.then(() => {
      const box = document.createElement('div');
      box.className = 'pwa-boot-error';
      box.textContent = 'This screen could not start (' + (err && err.message ? err.message : err) +
        '). If you are offline, open the app once while online so it can be saved for offline use.';
      document.body.appendChild(box);
    });
  }
})();
