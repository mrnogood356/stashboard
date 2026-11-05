import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * With the eye toggle on, every picture must be blurred. <img> and <video>
 * are covered by element; pictures drawn as backgrounds are covered by class.
 * This fails when a template draws a background picture with a class the
 * obscured rule in styles.scss doesn't list.
 */
const ROOT = join(process.cwd(), 'src');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files(path, out);
    } else if (/\.(html|ts)$/.test(name) && !name.endsWith('.spec.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Classes of elements whose background is a picture (url(...)). */
function backgroundPictureClasses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of files(join(ROOT, 'app'))) {
    const text = readFileSync(path, 'utf8');
    const tags = text.match(/<[a-z][^>]*>/gis) ?? [];
    for (const tag of tags) {
      if (!/\[style\.background(-image)?\]="[^"]*url\(/i.test(tag)) {
        continue;
      }
      const cls = /\bclass="([^"]+)"/.exec(tag)?.[1].split(/\s+/)[0];
      found.set(cls ?? '(no class)', path.replace(ROOT, 'src'));
    }
    // Background pictures set from code, e.g. the seek bar's preview frames.
    if (path.endsWith('.ts') && /'background-image':\s*`url\(/.test(text)) {
      const html = path.replace(/\.ts$/, '.html');
      try {
        const template = readFileSync(html, 'utf8');
        const cls = /class="([^"\s]+)[^"]*"\s+\[style\]=/.exec(template)?.[1];
        found.set(cls ?? '(no class)', path.replace(ROOT, 'src'));
      } catch {
        found.set('(no template)', path.replace(ROOT, 'src'));
      }
    }
  }
  return found;
}

describe('pictures with images obscured', () => {
  it('blurs every background picture the templates draw', () => {
    const styles = readFileSync(join(ROOT, 'styles.scss'), 'utf8');
    const obscured = new Set(
      [...styles.matchAll(/:root\[data-images='obscured'\]\s+\.([\w-]+)/g)].map((m) => m[1]),
    );
    // The feed's backdrop is blurred harder by its own styles.
    obscured.add('slide-backdrop');

    const missing = [...backgroundPictureClasses()]
      .filter(([cls]) => !obscured.has(cls))
      .map(([cls, path]) => `${cls} (${path})`);
    expect(missing).toEqual([]);
  });

  it('blurs pictures and previews, but not the player', () => {
    const styles = readFileSync(join(ROOT, 'styles.scss'), 'utf8');
    expect(styles).toMatch(/:root\[data-images='obscured'\] img,/);
    expect(styles).toMatch(/:root\[data-images='obscured'\] video:not\(\.player > \.video\)/);
  });
});
