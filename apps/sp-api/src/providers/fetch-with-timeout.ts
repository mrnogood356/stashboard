const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 30_000;

/** Statuses whose responses never carry a body (a Response can't be built with one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * fetch with a deadline that covers the whole exchange: connecting, the
 * headers and reading the body. A server that sends headers and then stalls
 * would otherwise hang the caller (and any sync job waiting on it) forever.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutController = new AbortController();
  const callerSignal = init.signal ?? null;
  const composedSignal = callerSignal
    ? composeAbortSignals(callerSignal, timeoutController.signal)
    : {
        signal: timeoutController.signal,
        cleanup: () => undefined,
      };
  const timeout = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  // A body nobody reads must not keep the process alive.
  timeout.unref?.();
  const done = () => {
    clearTimeout(timeout);
    composedSignal.cleanup();
  };

  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      signal: composedSignal.signal,
    });
  } catch (error) {
    done();
    throw error;
  }

  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    done();
    return response;
  }
  // Keep the deadline running until the body has been read (or failed).
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({ flush: done }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function composeAbortSignals(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const abortFromCaller = () => {
    controller.abort(callerSignal.reason);
  };
  const abortFromTimeout = () => {
    controller.abort(timeoutSignal.reason);
  };

  if (callerSignal.aborted) {
    abortFromCaller();
    return {
      signal: controller.signal,
      cleanup: () => undefined,
    };
  }

  if (timeoutSignal.aborted) {
    abortFromTimeout();
    return {
      signal: controller.signal,
      cleanup: () => undefined,
    };
  }

  callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      callerSignal.removeEventListener('abort', abortFromCaller);
      timeoutSignal.removeEventListener('abort', abortFromTimeout);
    },
  };
}
