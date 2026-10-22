/**
 * Which Stash paths the playback proxy may reach, relative to Stash's /scene/.
 * Anything else (other scenes, GraphQL, settings) is refused.
 */
const SCENE_ID_PATH =
  /^(\d+)\/(stream|stream\.mp4|stream\.webm|stream\.m3u8|stream\.m3u8\/\d+\.ts|vtt\/thumbs|vtt\/sprite|vtt\/chapter|caption|screenshot|preview)$/;
const HASH_PATH = /^([0-9a-f]{8,64})_(thumbs\.vtt|sprite\.jpg)$/;

/** Query parameters forwarded to Stash; everything else (e.g. apikey) is dropped. */
const ALLOWED_QUERY = new Set(['resolution', 'lang', 'type', 'start']);

export type StashStreamPath =
  | { kind: 'scene'; sceneId: string; rest: string }
  | { kind: 'hash'; hash: string; rest: string };

export function parseStashStreamPath(path: string): StashStreamPath | null {
  const normalized = path.replace(/^\/+/, '');
  if (normalized.includes('..')) {
    return null;
  }

  const byId = SCENE_ID_PATH.exec(normalized);
  if (byId) {
    return { kind: 'scene', sceneId: byId[1], rest: normalized };
  }

  const byHash = HASH_PATH.exec(normalized);
  if (byHash) {
    return { kind: 'hash', hash: byHash[1], rest: normalized };
  }

  return null;
}

export function filterStreamQuery(
  query: Record<string, unknown>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!ALLOWED_QUERY.has(key)) {
      continue;
    }
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.length <= 64) {
      params.set(key, first);
    }
  }
  return params;
}

export type StreamSourceKind = 'direct' | 'mp4' | 'webm' | 'hls';

export interface StreamSource {
  kind: StreamSourceKind;
  label: string;
  mimeType: string;
  /** Stash resolution key (e.g. FULL_HD); null for the original file. */
  resolution: string | null;
  /** Path below Stash's /scene/, e.g. "12/stream.m3u8?resolution=FULL_HD". */
  stashPath: string;
}

/**
 * Turns Stash's sceneStreams endpoints into sources the player can use.
 * DASH and MKV are skipped: browsers need extra libraries or can't play them.
 */
export function toStreamSources(
  sceneId: string,
  endpoints: Array<{ url?: unknown; mime_type?: unknown; label?: unknown }>,
): StreamSource[] {
  const sources: StreamSource[] = [];

  for (const endpoint of endpoints) {
    if (typeof endpoint.url !== 'string') {
      continue;
    }

    let url: URL;
    try {
      url = new URL(endpoint.url, 'http://stash.invalid');
    } catch {
      continue;
    }

    const match = /\/scene\/(\d+)\/(stream(?:\.mp4|\.webm|\.m3u8)?)$/.exec(
      url.pathname,
    );
    if (!match || match[1] !== sceneId) {
      continue;
    }

    const file = match[2];
    const kind: StreamSourceKind =
      file === 'stream'
        ? 'direct'
        : file === 'stream.mp4'
          ? 'mp4'
          : file === 'stream.webm'
            ? 'webm'
            : 'hls';
    const resolution = url.searchParams.get('resolution');
    const query = resolution
      ? `?resolution=${encodeURIComponent(resolution)}`
      : '';

    sources.push({
      kind,
      label:
        typeof endpoint.label === 'string' && endpoint.label.trim()
          ? endpoint.label.trim()
          : kind.toUpperCase(),
      mimeType:
        typeof endpoint.mime_type === 'string' && endpoint.mime_type
          ? endpoint.mime_type
          : kind === 'hls'
            ? 'application/vnd.apple.mpegurl'
            : kind === 'webm'
              ? 'video/webm'
              : 'video/mp4',
      resolution,
      stashPath: `${sceneId}/${file}${query}`,
    });
  }

  return sources;
}

/** Pulls Stash's file hash out of its sprite VTT path ("/scene/<hash>_thumbs.vtt"). */
export function hashFromVttPath(vttPath: unknown): string | null {
  if (typeof vttPath !== 'string') {
    return null;
  }
  const match = /\/scene\/([0-9a-f]{8,64})_thumbs\.vtt/.exec(vttPath);
  return match ? match[1] : null;
}
