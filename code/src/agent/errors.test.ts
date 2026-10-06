import { DEBUG_DETAIL_LIMIT, formatDebugDetail, isDebugErrorsEnabled, redactSecrets } from './errors';

describe('redactSecrets', () => {
  it('redacts explicitly supplied secrets', () => {
    expect(redactSecrets('value secret-value-123 here', ['secret-value-123'])).toBe('value [REDACTED] here');
  });

  it('redacts JWTs, Slack tokens, bearer values, and secret-named pairs', () => {
    const text = [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
      'slack xoxb-1234-5678-abcdef',
      'Authorization: Bearer abc',
      '"access_token": "plain-value"',
      'password=hunter2',
    ].join(' ');
    const result = redactSecrets(text);
    for (const leaked of ['eyJhbGciOiJIUzI1NiJ9', 'xoxb-1234', 'Bearer abc', 'plain-value', 'hunter2']) {
      expect(result).not.toContain(leaked);
    }
  });

  it('strips signed URL query strings', () => {
    expect(redactSecrets('GET https://s3.example.com/obj?X-Amz-Signature=abc&X-Amz-Credential=def')).toBe(
      'GET https://s3.example.com/obj?[REDACTED]'
    );
  });

  it('leaves ordinary DevRev IDs and errors readable', () => {
    const text = 'POST ai-agents.get [403] forbidden for don:core:dvrv-us-1:devo/198YjPXtdd:ai_agent/2';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('formatDebugDetail', () => {
  it('prefixes the step and trims long details', () => {
    const detail = formatDebugDetail('chats_create', 'x '.repeat(1000));
    expect(detail.startsWith('[debug] step=chats_create: ')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual('[debug] step=chats_create: '.length + DEBUG_DETAIL_LIMIT);
  });
});

describe('isDebugErrorsEnabled', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    [true, true],
    ['false', false],
    [undefined, false],
    ['', false],
  ])('%p -> %p', (value, expected) => {
    expect(isDebugErrorsEnabled(value)).toBe(expected);
  });
});
