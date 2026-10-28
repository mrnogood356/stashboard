import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportingErrorHandler, reportToServer } from './client-log';

describe('client log', () => {
  afterEach(() => vi.restoreAllMocks());

  function sentBodies(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, string>,
    );
  }

  it('sends uncaught errors to the server log, with the stack', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new ReportingErrorHandler().handleError(new TypeError('x is undefined'));

    expect(fetchMock).toHaveBeenCalledWith('/api/client-log', expect.anything());
    const [body] = sentBodies(fetchMock);
    expect(body['level']).toBe('error');
    expect(body['message']).toBe('TypeError: x is undefined');
    expect(body['detail']).toContain('TypeError');
    vi.unstubAllGlobals();
  });

  it('leaves out the browser’s detail-free “Script error.” from other sites’ scripts', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new ReportingErrorHandler().handleError(new Error('Script error.'));
    new ReportingErrorHandler().handleError(new ErrorEvent('error', { message: 'Script error.' }));

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('sends the same message only once a minute, and never throws', () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => {
      reportToServer('warn', 'Unlock with PIN failed: Wrong PIN');
      reportToServer('warn', 'Unlock with PIN failed: Wrong PIN');
    }).not.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
