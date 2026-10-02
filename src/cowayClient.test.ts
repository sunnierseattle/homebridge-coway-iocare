import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CowayClient } from './cowayClient.js';
import { CowayAuthError, PasswordExpiredError, RateLimitedError } from './errors.js';
import { TOKEN_REFRESH_MARGIN_MS } from './settings.js';

const tokens = (expiresInMs: number) => ({
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.now() + expiresInMs,
});

function makeClient(auth: Partial<Parameters<typeof CowayClient.prototype.constructor>[2]> = {}) {
  const deps = {
    login: vi.fn().mockResolvedValue(tokens(60 * 60 * 1000)),
    refresh: vi.fn().mockResolvedValue(tokens(60 * 60 * 1000)),
    ...auth,
  };
  return { client: new CowayClient('u', 'p', deps as never), deps };
}

describe('CowayClient token lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs in exactly once and reuses the token across calls', async () => {
    const { client, deps } = makeClient();
    await client.accessToken();
    await client.accessToken();
    await client.accessToken();
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('refreshes rather than re-logging in when the token is near expiry', async () => {
    const { client, deps } = makeClient({
      login: vi.fn().mockResolvedValue(tokens(TOKEN_REFRESH_MARGIN_MS - 1000)),
    });
    await client.accessToken();
    await client.accessToken();
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full login when the refresh token has been rejected', async () => {
    const { client, deps } = makeClient({
      login: vi.fn()
        .mockResolvedValueOnce(tokens(TOKEN_REFRESH_MARGIN_MS - 1000))
        .mockResolvedValue(tokens(60 * 60 * 1000)),
      refresh: vi.fn().mockRejectedValue(new Error('invalid refresh token')),
    });
    await client.accessToken();
    await expect(client.accessToken()).resolves.toBe('access');
    expect(deps.login).toHaveBeenCalledTimes(2);
  });

  it('does not retry after a rate-limit error, so it cannot deepen the block', async () => {
    const { client, deps } = makeClient({
      login: vi.fn().mockRejectedValue(new RateLimitedError('blocked')),
    });
    await expect(client.accessToken()).rejects.toThrow(RateLimitedError);
    await expect(client.accessToken()).rejects.toThrow(RateLimitedError);
    expect(deps.login).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rejected credentials', new CowayAuthError('bad password')],
    ['a forced password change', new PasswordExpiredError('change it')],
  ])('stops logging in after %s, since every retry counts towards a lockout', async (_, error) => {
    const { client, deps } = makeClient({ login: vi.fn().mockRejectedValue(error) });
    await expect(client.accessToken()).rejects.toBe(error);
    await expect(client.accessToken()).rejects.toBe(error);
    expect(deps.login).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a login that failed for a transient reason', async () => {
    const { client } = makeClient({
      login: vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue(tokens(60 * 60 * 1000)),
    });
    await expect(client.accessToken()).rejects.toThrow('socket hang up');
    await expect(client.accessToken()).resolves.toBe('access');
  });

  it('collapses concurrent callers onto a single login', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r; 
    });
    const { client, deps } = makeClient({
      login: vi.fn().mockImplementation(async () => {
        await gate; return tokens(60 * 60 * 1000); 
      }),
    });
    const all = Promise.all([client.accessToken(), client.accessToken(), client.accessToken()]);
    release(null);
    await all;
    expect(deps.login).toHaveBeenCalledTimes(1);
  });
});

describe('CowayClient login options', () => {
  it('passes the password-change preference through to the login', async () => {
    const login = vi.fn().mockResolvedValue(tokens(60 * 60 * 1000));
    const client = new CowayClient('u', 'p', { login }, { skipPasswordChange: true });
    await client.accessToken();
    expect(login).toHaveBeenCalledWith('u', 'p', { skipPasswordChange: true });
  });
});
