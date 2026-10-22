import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PrimeNG's p-select and p-multiselect focus a <span role="combobox">, which a
 * <label> can't name, so screen readers would announce only the current value.
 * Each one needs ariaLabelledBy (pointing at its visible label) or ariaLabel.
 * The template linter can't see this, so it is checked here.
 */
describe('dropdown accessibility', () => {
  it('gives every p-select and p-multiselect an accessible name', () => {
    const root = join(process.cwd(), 'src/app');
    const unnamed: string[] = [];
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.html')) {
        continue;
      }
      const template = readFileSync(join(root, file), 'utf8');
      for (const match of template.matchAll(/<p-(?:select|multiselect)\b[^>]*>/g)) {
        const tag = match[0];
        if (!/\b(?:ariaLabelledBy|ariaLabel)\b/.test(tag)) {
          const line = template.slice(0, match.index).split('\n').length;
          unnamed.push(`${file}:${line}`);
        }
        const labelledBy = /\bariaLabelledBy="([^"]+)"/.exec(tag)?.[1];
        if (labelledBy && !template.includes(`id="${labelledBy}"`)) {
          unnamed.push(`${file}: ariaLabelledBy="${labelledBy}" has no matching id`);
        }
      }
    }
    expect(unnamed).toEqual([]);
  });
});
