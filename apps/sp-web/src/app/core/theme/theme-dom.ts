import { AppearanceSettings } from './appearance.types';
import { AppliedTheme, CUSTOM_CSS_STYLE_ID, THEME_STYLE_ID, resolveApplied } from './theme-tokens';
import { ColorScheme, darkThemeOrDefault, lightThemeOrDefault } from './themes';

/**
 * Writes a resolved theme onto the page. public/theme-boot.js does the same
 * from the cache before Angular loads; keep the two in step.
 */
export function applyAppearanceToDocument(
  doc: Document,
  settings: AppearanceSettings,
  scheme: ColorScheme,
): AppliedTheme {
  const theme =
    scheme === 'dark'
      ? darkThemeOrDefault(settings.darkTheme)
      : lightThemeOrDefault(settings.lightTheme);
  const applied = resolveApplied(theme, settings.accentColor);
  const root = doc.documentElement;

  root.setAttribute('data-theme', scheme);
  root.setAttribute('data-theme-id', applied.id);
  root.style.colorScheme = scheme;
  setOrRemoveAttribute(root, 'data-radius', settings.radius, 'default');
  setOrRemoveAttribute(root, 'data-density', settings.density, 'comfortable');
  setOrRemoveAttribute(root, 'data-font-scale', settings.fontScale, 'default');
  // Adaptive is glass too; data-glass-art adds the page's artwork behind it.
  setOrRemoveAttribute(
    root,
    'data-material',
    settings.material === 'solid' ? 'solid' : 'glass',
    'solid',
  );
  root.toggleAttribute('data-glass-art', settings.material === 'adaptive');

  styleElement(doc, THEME_STYLE_ID, doc.head).textContent = applied.css;
  applyCustomCss(doc, settings.customCss);
  applyStatusBar(doc, applied.themeColor, scheme);
  return applied;
}

function setOrRemoveAttribute(
  root: HTMLElement,
  name: string,
  value: string,
  defaultValue: string,
): void {
  if (value === defaultValue) {
    root.removeAttribute(name);
  } else {
    root.setAttribute(name, value);
  }
}

function styleElement(doc: Document, id: string, parent: HTMLElement): HTMLStyleElement {
  let element = doc.getElementById(id) as HTMLStyleElement | null;
  if (!element || element.tagName !== 'STYLE') {
    element = doc.createElement('style');
    element.id = id;
    parent.appendChild(element);
  }
  return element;
}

/**
 * Custom CSS goes in as a <style> element's text, never parsed as HTML, so
 * `</style><script>` in it is just (invalid) CSS. It sits at the end of the
 * body so it wins ties with the app's own styles.
 */
export function applyCustomCss(doc: Document, css: string): void {
  const existing = doc.getElementById(CUSTOM_CSS_STYLE_ID);
  if (!css.trim()) {
    existing?.remove();
    return;
  }
  const parent = doc.body ?? doc.head;
  const element = styleElement(doc, CUSTOM_CSS_STYLE_ID, parent);
  if (element.parentElement !== parent || element !== parent.lastElementChild) {
    parent.appendChild(element);
  }
  element.textContent = css;
}

/**
 * Phone status bar: theme-color tints browser chrome; in the home-screen app
 * a dark theme draws under a translucent bar (the shell pads for it) so the
 * bar shows the theme's own background, and a light theme gets the light bar.
 */
export function applyStatusBar(doc: Document, themeColor: string, scheme: ColorScheme): void {
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.appendChild(meta);
  }
  meta.content = themeColor;

  const appleBar = doc.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  );
  if (appleBar) {
    appleBar.content = scheme === 'dark' ? 'black-translucent' : 'default';
  }
}
