import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * On an iPhone a page wider than the screen can be dragged sideways or zoomed
 * out, and a field under 16px zooms the page in when focused. jsdom has no
 * layout, so these check the rules that prevent both are still in place.
 */
const src = join(process.cwd(), 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const scssFiles = () =>
  (readdirSync(join(src, 'app'), { recursive: true }) as string[])
    .filter((file) => file.endsWith('.scss'))
    .map((file) => `app/${file}`)
    .concat('styles.scss');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(scss: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(scss)?.[1] ?? '';
}

describe('phone layout', () => {
  it('keeps the viewport at device width without blocking zoom', () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(read('index.html'))?.[1] ?? '';
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('initial-scale=1');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/user-scalable=no|maximum-scale/);
  });

  it('gives fields at least 16px text on touch screens so iOS does not zoom', () => {
    const styles = read('styles.scss');
    expect(styles).toMatch(
      /@media \(pointer: coarse\) \{[^}]*font-size: max\(16px, 1em\) !important;/,
    );
  });

  it('lets the shared layout blocks shrink below their longest word', () => {
    const styles = read('styles.scss');
    expect(styles).toMatch(
      /\.app-section-stack > \*,\n\.app-section-panel > \*,[^{]*\{\s*min-width: 0;/,
    );
  });

  it('never uses a bare 1fr single column, which a long name can stretch past the screen', () => {
    const offenders = scssFiles().filter((file) =>
      /grid-template-columns:\s*1fr\s*;/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('wraps long release names and indexers in the release picker', () => {
    const picker = read('app/shared/release-picker/release-picker.component.scss');
    expect(rule(picker, '.list')).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(rule(picker, '.release-copy')).toContain('min-width: 0');
    expect(rule(picker, '.release-copy')).toContain('overflow-wrap: anywhere');
    expect(rule(picker, '.release-title')).toContain('overflow-wrap: anywhere');
    expect(rule(picker, '.chip.faint')).toContain('white-space: normal');
    expect(rule(picker, '.body')).toContain('overflow-x: hidden');
    expect(rule(picker, '.sheet')).toContain('max-width: 100vw');
  });
});
