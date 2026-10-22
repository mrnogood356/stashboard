import { PlaybackTokenService } from './playback-token.service';

describe('PlaybackTokenService', () => {
  const service = new PlaybackTokenService();

  it('round-trips a scene grant', () => {
    const { token } = service.issue('12', 'abc123def4567890');
    expect(service.verify(token)).toEqual(
      expect.objectContaining({ sceneId: '12', hash: 'abc123def4567890' }),
    );
  });

  it('rejects tampered and expired tokens', () => {
    const { token } = service.issue('12', null);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ s: '13', h: null, e: 9999999999 }),
    ).toString('base64url');
    expect(service.verify(`${forged}.${sig}`)).toBeNull();
    // A different first character, whatever the signature starts with.
    const swapped = sig[0] === 'x' ? 'y' : 'x';
    expect(service.verify(`${payload}.${swapped}${sig.slice(1)}`)).toBeNull();
    expect(service.verify(service.issue('12', null, -1).token)).toBeNull();
  });
});
