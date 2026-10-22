/**
 * The address of a Stash image through Stashboard's media proxy. The version
 * changes when the picture does, so browsers (and the server's own cache) can
 * keep each version for good and still never show an outdated one.
 */
export function stashMediaUrl(
  path: string,
  version: string | null | undefined,
  width?: number,
): string {
  const query = new URLSearchParams();
  if (version) {
    query.set('v', version);
  }
  if (width) {
    query.set('w', String(width));
  }
  const search = query.toString();
  return `/api/media/stash/${path}${search ? `?${search}` : ''}`;
}
