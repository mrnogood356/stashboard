import { HomeAttentionService } from './home-attention.service';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

describe('HomeController', () => {
  it('returns the "Needs you" counts from the attention service', async () => {
    const counts = {
      matchesToCheck: 1,
      failed: null,
      waitingForImport: 0,
      unmatched: 5,
    };
    const attention = {
      getAttention: jest.fn().mockResolvedValue(counts),
    } as unknown as HomeAttentionService;
    const controller = new HomeController({} as HomeService, attention);

    await expect(controller.getAttention()).resolves.toEqual(counts);
    expect(attention.getAttention).toHaveBeenCalledTimes(1);
  });
});
