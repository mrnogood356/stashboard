/**
 * The tagNames query param: names in the same order as tags, each
 * URI-encoded so a name with a comma ("Cum, Facial") stays one name.
 */
export function joinTagNames(names: string[]): string {
  return names.map((name) => encodeURIComponent(name.trim())).join(',');
}

/** Reads joinTagNames, and older links that put the names in as they are. */
export function splitTagNames(param: string | null): string[] {
  return (param ?? '').split(',').map((part) => {
    try {
      return decodeURIComponent(part).trim();
    } catch {
      return part.trim();
    }
  });
}
