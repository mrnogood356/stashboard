import { describe, expect, it } from 'vitest';
import { backLabelFor } from './back-label';

describe('backLabelFor', () => {
  it('names Search when a page was opened from it', () => {
    expect(backLabelFor('/search', 'Back to Performers')).toBe('Back to Search');
  });

  it('tells a list from one of its items', () => {
    expect(backLabelFor('/performers')).toBe('Back to Performers');
    expect(backLabelFor('/performer/42')).toBe('Back to Performer');
    expect(backLabelFor('/library/studio/7')).toBe('Back to Studio');
    expect(backLabelFor('/library')).toBe('Back to Library');
  });

  it('falls back to the page’s own label for anywhere else', () => {
    expect(backLabelFor('/settings/about', 'Back to Studios')).toBe('Back to Studios');
    expect(backLabelFor('/settings/about')).toBe('Back');
  });
});
