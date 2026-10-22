/*
 * Paints the saved theme before Angular starts, so a reload never flashes the
 * wrong colours. Reads what ThemeService last applied (localStorage
 * "sp-appearance-v1"); the app then checks the server and corrects it if
 * another device changed it. Kept in step with core/theme/theme-dom.ts.
 * A separate file, not inline, so the Content-Security-Policy needs no exception.
 */
(function () {
  var root = document.documentElement;
  var prefersDark = false;
  try {
    prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) {
    /* keep light */
  }

  function setMeta(name, content) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (meta) {
      meta.setAttribute('content', content);
    }
  }

  function addStyle(id, css) {
    var style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  var cache = null;
  var legacy = null;
  try {
    cache = JSON.parse(window.localStorage.getItem('sp-appearance-v1') || 'null');
    legacy = window.localStorage.getItem('sp-theme');
  } catch (e) {
    cache = null;
  }

  var scheme;
  if (cache && cache.v === 1 && cache.light && cache.dark) {
    scheme = cache.mode === 'system' ? (prefersDark ? 'dark' : 'light') : cache.mode;
  } else if (legacy === 'light' || legacy === 'dark') {
    scheme = legacy;
    cache = null;
  } else {
    scheme = prefersDark ? 'dark' : 'light';
    cache = null;
  }
  if (scheme !== 'light' && scheme !== 'dark') {
    scheme = 'dark';
  }

  root.setAttribute('data-theme', scheme);
  root.style.colorScheme = scheme;
  setMeta('apple-mobile-web-app-status-bar-style', scheme === 'dark' ? 'black-translucent' : 'default');

  if (!cache) {
    setMeta('theme-color', scheme === 'dark' ? '#0b0b0d' : '#f2f2f7');
    return;
  }

  var theme = cache[scheme];
  root.setAttribute('data-theme-id', String(theme.id || ''));
  if (cache.radius && cache.radius !== 'default') {
    root.setAttribute('data-radius', String(cache.radius));
  }
  if (cache.density && cache.density !== 'comfortable') {
    root.setAttribute('data-density', String(cache.density));
  }
  if (cache.fontScale && cache.fontScale !== 'default') {
    root.setAttribute('data-font-scale', String(cache.fontScale));
  }
  if (typeof theme.css === 'string') {
    addStyle('sp-theme-tokens', theme.css);
  }
  if (typeof cache.customCss === 'string' && cache.customCss.trim()) {
    addStyle('sp-custom-css', cache.customCss);
  }
  if (typeof theme.themeColor === 'string') {
    setMeta('theme-color', theme.themeColor);
  }
})();
