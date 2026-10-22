import { redact } from './redact';

describe('redact', () => {
  it('removes secrets from query strings', () => {
    expect(
      redact('GET http://whisparr:6969/api/v3/movie?apikey=abc123&term=x 200'),
    ).toBe(
      'GET http://whisparr:6969/api/v3/movie?apikey=[redacted]&term=x 200',
    );
    expect(
      redact(
        '/api?mode=queue&api_key=s3cret&output=json&token=t0k&password=pw',
      ),
    ).toBe(
      '/api?mode=queue&api_key=[redacted]&output=json&token=[redacted]&password=[redacted]',
    );
    expect(redact('/api/automation/webhook?TOKEN=abc')).toBe(
      '/api/automation/webhook?TOKEN=[redacted]',
    );
  });

  it('removes header values', () => {
    expect(redact('ApiKey: abc123')).toBe('ApiKey: [redacted]');
    expect(redact('headers X-Api-Key: abc123, Accept: json')).toBe(
      'headers X-Api-Key: [redacted], Accept: json',
    );
    expect(redact('Authorization: Bearer eyJhbGciOi.payload.sig')).toBe(
      'Authorization: [redacted]',
    );
    expect(redact('sent with Bearer eyJhbGciOi.payload.sig')).toBe(
      'sent with Bearer [redacted]',
    );
  });

  it('removes JSON and object fields named like secrets', () => {
    expect(
      redact(
        '{"baseUrl":"http://stash","apiKey":"abc","password":"pw","webhookToken":"t","clientSecret":"s","name":"ok"}',
      ),
    ).toBe(
      '{"baseUrl":"http://stash","apiKey":"[redacted]","password":"[redacted]","webhookToken":"[redacted]","clientSecret":"[redacted]","name":"ok"}',
    );
    expect(redact('{ "token" : "a \\" quoted" }')).toBe(
      '{ "token" : "[redacted]" }',
    );
    expect(redact("{ apiKey: 'abc', url: 'http://x' }")).toBe(
      "{ apiKey: '[redacted]', url: 'http://x' }",
    );
  });

  it('removes passwords in URLs', () => {
    expect(redact('postgresql://stashboard:hunter2@db:5432/stashboard')).toBe(
      'postgresql://stashboard:[redacted]@db:5432/stashboard',
    );
  });

  it('leaves ordinary text alone', () => {
    const text =
      'Synced 120 scenes from Stash in 3.2s (tokens of appreciation: none)';
    expect(redact(text)).toBe(text);
    expect(redact('')).toBe('');
  });

  it('is safe to run twice', () => {
    const once = redact(
      '?apikey=abc {"password":"x"} Authorization: Basic Zm9v',
    );
    expect(redact(once)).toBe(once);
  });
});
