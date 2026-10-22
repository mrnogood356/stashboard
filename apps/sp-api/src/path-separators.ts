/**
 * Trimming / and \ from folder paths without a regex: `/[\\/]+$/` backtracks
 * quadratically on a long run of separators followed by anything else.
 */

function isSeparator(char: string): boolean {
  return char === '/' || char === '\\';
}

/** The path without any / or \ at its end ("/data/" → "/data", "/" → ""). */
export function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && isSeparator(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Like trimTrailingSeparators, but never drops the first character ("/" stays "/"). */
export function trimTrailingSeparatorsKeepFirst(value: string): string {
  let end = value.length;
  while (end > 1 && isSeparator(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** The path without any / or \ at either end. */
export function trimSeparators(value: string): string {
  let start = 0;
  while (start < value.length && isSeparator(value[start])) {
    start += 1;
  }
  return trimTrailingSeparators(value.slice(start));
}
