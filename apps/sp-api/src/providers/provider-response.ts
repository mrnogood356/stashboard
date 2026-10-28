/** Longest piece of an error body worth showing; whole HTML pages are not. */
const MAX_ERROR_BODY_CHARS = 200;

/**
 * Reading a provider's reply went wrong: it stalled past the deadline, the
 * connection dropped, or the body wasn't the JSON a provider sends. The
 * message says which, in words fit for the UI.
 */
export class ProviderResponseError extends Error {}

/** The body as text, or a ProviderResponseError saying why it couldn't be read. */
export async function readResponseText(
  response: Response,
  provider: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderResponseError(
      isAbortError(error)
        ? `${provider} took too long to respond.`
        : `The connection to ${provider} dropped while reading its response.`,
    );
  }
}

/**
 * The body parsed as JSON (null for an empty body). A login page from a
 * reverse proxy, or a wrong URL that serves some other site, gets a clear
 * ProviderResponseError instead of a bare SyntaxError.
 */
export async function readJsonResponse<T = unknown>(
  response: Response,
  provider: string,
): Promise<T | null> {
  // Some test doubles only implement json().
  if (typeof response.text !== 'function') {
    return (await response.json()) as T;
  }
  const text = await readResponseText(response, provider);
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = summarizeErrorBody(text);
    throw new ProviderResponseError(
      `${provider} replied with something that isn't JSON${preview ? ` ("${preview}")` : ''}. Check its URL.`,
    );
  }
}

/** "returned 502: Bad Gateway", with the body cut down to something readable. */
export async function describeErrorResponse(
  response: Response,
  provider: string,
): Promise<string> {
  let body = '';
  try {
    body =
      typeof response.text === 'function'
        ? summarizeErrorBody(await response.text())
        : '';
  } catch {
    // The status alone still says what went wrong.
  }
  return `${provider} returned ${response.status}${body ? `: ${body}` : ''}`;
}

/** HTML tags dropped, whitespace collapsed, and cut to a sentence's length. */
export function summarizeErrorBody(body: string): string {
  const text = body
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_ERROR_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_ERROR_BODY_CHARS).trimEnd()}…`;
}

/** Aborts surface as DOMExceptions, which aren't always instanceof Error. */
function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Stash, Whisparr or the catalog couldn't be reached at all (down,
 * restarting, wrong address), as opposed to answering with an error.
 */
export function isProviderUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Failed to reach ');
}

/** Stashboard's own database was restarting or briefly out of reach. */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'P1001' || code === 'P1017' || code === 'P2028') {
    return true;
  }
  return (
    error instanceof Error &&
    /\b57P0[123]\b|the database system is (shutting down|starting up)|Transaction not found/i.test(
      error.message,
    )
  );
}
