export const REDACTED = '[redacted]';

/** Names whose value is a secret: apiKey, api_key, x-api-key, password, token, secret… */
const SECRET_NAME =
  '[A-Za-z0-9_-]*(?:api[_-]?key|apikey|password|passwd|token|secret|authorization|session[_-]?id)';

const RULES: Array<[RegExp, string]> = [
  // JSON fields: "apiKey": "…", "webhookToken":"…"
  [
    new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    `$1"${REDACTED}"`,
  ],
  // Objects as Node prints them: { apiKey: 'abc' }
  [
    new RegExp(`\\b(${SECRET_NAME})(\\s*:\\s*)'(?:[^'\\\\]|\\\\.)*'`, 'gi'),
    `$1$2'${REDACTED}'`,
  ],
  // Headers, as logged or in an error: "X-Api-Key: …", "Authorization: Bearer …".
  [
    /\b(authorization|proxy-authorization|x-api-key|api-key|apikey|cookie|set-cookie)(\s*:\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;"'}]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Query strings and form bodies: ?apikey=…&token=…
  [
    new RegExp(`([?&;\\s,(]|^)(${SECRET_NAME})=[^&\\s"'#),]+`, 'gi'),
    `$1$2=${REDACTED}`,
  ],
  // Credentials in a URL: postgres://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@/\s]+@/gi, `$1:${REDACTED}@`],
  // A bare bearer token anywhere else.
  [/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
];

/**
 * The text with API keys, passwords, tokens and secrets replaced, so logs
 * can be shared in a support message. Runs on every entry before it's
 * written anywhere.
 */
export function redact(text: string): string {
  if (!text) {
    return text;
  }
  let result = text;
  for (const [pattern, replacement] of RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
