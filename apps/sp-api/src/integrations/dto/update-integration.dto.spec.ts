import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateIntegrationDto } from './update-integration.dto';

function errorsFor(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(UpdateIntegrationDto, body)).map(
    (error) => error.property,
  );
}

describe('UpdateIntegrationDto', () => {
  it('accepts LAN and internet web addresses', () => {
    expect(errorsFor({ baseUrl: 'http://192.168.1.10:9999' })).toEqual([]);
    expect(errorsFor({ baseUrl: 'http://stash:9999/' })).toEqual([]);
    expect(errorsFor({ baseUrl: 'https://stashdb.org/graphql' })).toEqual([]);
  });

  it('refuses addresses that are not http or https', () => {
    expect(errorsFor({ baseUrl: 'ftp://stash.local' })).toEqual(['baseUrl']);
    expect(errorsFor({ baseUrl: 'file://stash/etc/passwd' })).toEqual([
      'baseUrl',
    ]);
  });

  it('refuses absurdly long values', () => {
    expect(errorsFor({ apiKey: 'k'.repeat(10_000) })).toEqual(['apiKey']);
    expect(errorsFor({ name: 'n'.repeat(500) })).toEqual(['name']);
  });
});
