import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from './appearance.types';
import { contrastRatio } from './color-contrast';
import { TEXT_CONTRAST } from './theme-tokens';
import { applyAppearanceToDocument } from './theme-dom';
import { ALL_THEMES } from './themes';

/**
 * Native <select> option lists are drawn by the browser. In a dark theme they
 * showed light text on the system's white list, because the select's own
 * background was transparent and options had no colours of their own.
 */
describe('native form controls follow the theme', () => {
  const styles = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');

  function rule(selector: string): string {
    const start = styles.indexOf(`${selector} {`);
    expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
    return styles.slice(start, styles.indexOf('}', start));
  }

  it('sets color-scheme on <html> for every theme, so native popups match', () => {
    for (const theme of ALL_THEMES) {
      document.documentElement.removeAttribute('style');
      const settings =
        theme.scheme === 'dark'
          ? { ...DEFAULT_APPEARANCE, darkTheme: theme.id }
          : { ...DEFAULT_APPEARANCE, lightTheme: theme.id };
      applyAppearanceToDocument(document, settings, theme.scheme);
      expect(document.documentElement.style.colorScheme, theme.id).toBe(theme.scheme);
      expect(document.documentElement.getAttribute('data-theme-id'), theme.id).toBe(theme.id);
    }
  });

  it('declares color-scheme in the stylesheet too, for the paint before the theme script', () => {
    expect(rule(":root[data-theme='dark']")).toBeTruthy();
    expect(styles).toMatch(/:root\[data-theme='dark'\] \{\s*color-scheme: dark;/);
    expect(styles).toMatch(/:root \{\s*color-scheme: light;/);
  });

  it('gives option lists a themed background and text, never inherited transparency', () => {
    const options = rule('select option,\nselect optgroup');
    expect(options).toContain('background-color: var(--surface-elevated)');
    expect(options).toContain('color: var(--text-primary)');
    expect(rule('select option:disabled')).toContain('color: var(--text-muted)');
    expect(rule('select option:checked')).toContain('var(--accent)');
    const select = rule('select');
    expect(select).toContain('background-color: var(--app-control-bg)');
    expect(select).toContain('color: var(--app-control-text)');
  });

  it('defines the control tokens on :root, not only inside .app-control-shell', () => {
    const root = styles.slice(styles.indexOf(':root {\n  --app-control-height'));
    expect(root).toMatch(/^:root \{[^}]*--app-control-bg: var\(--surface-2\);/);
    expect(root).toMatch(/^:root \{[^}]*--app-control-text: var\(--text-primary\);/);
  });

  it('keeps option text readable on the option background in every theme', () => {
    for (const theme of ALL_THEMES) {
      const p = theme.palette;
      expect(contrastRatio(p.text, p.elevated), `${theme.id} option`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.text, p.raised), `${theme.id} hovered`).toBeGreaterThanOrEqual(
        TEXT_CONTRAST,
      );
      expect(contrastRatio(p.textMuted, p.elevated), `${theme.id} disabled`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});
