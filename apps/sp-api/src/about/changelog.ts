import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ReleaseNotes {
  version: string;
  /** YYYY-MM-DD, as the changelog has it; null when it doesn't. */
  date: string | null;
  features: string[];
  fixes: string[];
}

const HEADING =
  /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?\s*(?:\((\d{4}-\d{2}-\d{2})\))?/;
/** Fix lines about review rounds say nothing to someone using the app. */
const NOISE = /^(address(ed)? review|review fixes)/i;
/**
 * Section headings, as release-please writes them and as tidied notes do
 * ("New", "Faster", "Fixed", "Security"). Any other section isn't shown.
 */
const FEATURE_SECTIONS = new Set([
  'features',
  'new',
  'added',
  'improved',
  'faster',
  'performance improvements',
]);
const FIX_SECTIONS = new Set(['bug fixes', 'fixed', 'fixes', 'security']);

/**
 * The releases in release-please's CHANGELOG.md, newest first, as plain
 * sentences: no commit links, no "**web:**" scopes, and no repeats (a change
 * merged twice is listed once).
 */
export function parseChangelog(text: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  let current: ReleaseNotes | null = null;
  let list: string[] | null = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = {
        version: heading[1],
        date: heading[2] ?? null,
        features: [],
        fixes: [],
      };
      releases.push(current);
      list = null;
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('### ')) {
      const title = line.slice(4).trim().toLowerCase();
      list = FEATURE_SECTIONS.has(title)
        ? current.features
        : FIX_SECTIONS.has(title)
          ? current.fixes
          : null;
      continue;
    }
    if (list && /^\s*[*-]\s+/.test(line)) {
      const sentence = cleanEntry(line);
      if (sentence && !NOISE.test(sentence) && !list.includes(sentence)) {
        list.push(sentence);
      }
    }
  }
  return releases;
}

function cleanEntry(line: string): string {
  const text = line
    .replace(/^\s*[*-]\s+/, '')
    // A commit's "**web:** " scope. A tidied line's "**Requests:** " area
    // is kept, as "Requests: ".
    .replace(/^\*\*[a-z0-9-]+:\*\*\s*/, '')
    // " ([abc1234](https://…/commit/…))", " ([#12](…/pull/12))" and
    // ", closes [#12](…)".
    .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/g, '')
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, '')
    .replace(/,?\s*closes\s+\[#\d+\]\([^)]*\)/gi, '')
    // Any other markdown link keeps just its text.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // What's left of a list of pull requests: " (#119, #120)".
    .replace(/\s*\(#\d+(?:,\s*#\d+)*\)/g, '')
    // Shown as plain text: no bold or code marks.
    .replace(/\*\*|`/g, '')
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** -1, 0 or 1; anything that isn't x.y.z is null. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return null;
  }
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * CHANGELOG.md, found by walking up from here: /app in the image (the
 * Dockerfile copies it there), the repository root when run from a checkout.
 */
export function readChangelog(start: string = __dirname): string | null {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'CHANGELOG.md');
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
