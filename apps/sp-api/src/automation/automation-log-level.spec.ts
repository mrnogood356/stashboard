import { NOTHING_DONE } from './automation.service';

describe('which automation runs are routine', () => {
  it('quiets only a run that found nothing and just rescanned', () => {
    expect(NOTHING_DONE.test('No new scenes found.')).toBe(true);
    expect(NOTHING_DONE.test('No new scenes found, rescanned 1 folder.')).toBe(
      true,
    );
    expect(NOTHING_DONE.test('No new scenes found, rescanned 3 folders.')).toBe(
      true,
    );
    // Did something worth reading later: stays at info.
    expect(
      NOTHING_DONE.test(
        'No new scenes found, made previews for 2 earlier scenes.',
      ),
    ).toBe(false);
    expect(
      NOTHING_DONE.test('No new scenes found, linked 1 waiting for import.'),
    ).toBe(false);
    expect(NOTHING_DONE.test('Found 2 new scenes, rescanned 1 folder.')).toBe(
      false,
    );
  });
});
