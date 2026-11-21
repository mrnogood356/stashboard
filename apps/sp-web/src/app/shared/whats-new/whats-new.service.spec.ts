import { describe, expect, it, vi } from 'vitest';
import { WhatsNewService } from './whats-new.service';

describe('WhatsNewService', () => {
  it('passes a request straight to the note when it is on the page', () => {
    const service = new WhatsNewService();
    const shown = vi.fn();
    service.requests.subscribe(shown);

    service.show();

    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('keeps a request made before the note loaded, and shows it once', async () => {
    const service = new WhatsNewService();
    service.show();

    const shown = vi.fn();
    service.requests.subscribe(shown);
    await Promise.resolve();

    expect(shown).toHaveBeenCalledTimes(1);
    const again = vi.fn();
    service.requests.subscribe(again);
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
  });
});
