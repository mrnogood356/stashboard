import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from './appearance.types';
import { applyAppearanceToDocument } from './theme-dom';

describe('applyAppearanceToDocument', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.removeAttribute('data-material');
    root.removeAttribute('data-glass-art');
  });

  it('makes Adaptive glass a glass style that also shows the page’s artwork', () => {
    applyAppearanceToDocument(document, { ...DEFAULT_APPEARANCE, material: 'adaptive' }, 'dark');
    expect(root.getAttribute('data-material')).toBe('glass');
    expect(root.hasAttribute('data-glass-art')).toBe(true);

    applyAppearanceToDocument(document, { ...DEFAULT_APPEARANCE, material: 'glass' }, 'dark');
    expect(root.getAttribute('data-material')).toBe('glass');
    expect(root.hasAttribute('data-glass-art')).toBe(false);

    applyAppearanceToDocument(document, { ...DEFAULT_APPEARANCE, material: 'solid' }, 'dark');
    expect(root.hasAttribute('data-material')).toBe(false);
    expect(root.hasAttribute('data-glass-art')).toBe(false);
  });
});
