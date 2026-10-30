import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copy-text';

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
  });

  it('uses the clipboard API on a secure page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await copyText('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('copies through a hidden text box on http://, and tidies up after', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    let selected = '';
    const execCommand = vi.fn(() => {
      selected = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    await copyText('GET /api/requests 200 57117ms');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('GET /api/requests 200 57117ms');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('says so when the browser won’t copy either way', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });

    await expect(copyText('x')).rejects.toThrow();
  });
});
