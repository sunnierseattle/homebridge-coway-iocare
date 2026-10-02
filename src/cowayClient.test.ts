import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('CowayClient requests', () => {
  const device = {
    deviceSerial: 'S1', nickname: 'Bedroom', placeId: 'P1', modelCode: 'M', productModel: 'AP-2015E',
  };
  const json = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  });

  function makeRequestClient() {
    const deps = {
      login: vi.fn().mockResolvedValue(tokens(60 * 60 * 1000)),
      refresh: vi.fn().mockResolvedValue({ ...tokens(60 * 60 * 1000), accessToken: 'fresh' }),
      sleep: vi.fn().mockResolvedValue(undefined),
    };
    return { client: new CowayClient('u', 'p', deps), deps };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('refreshes the session and retries once when Coway rejects the token early', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(401))
      .mockResolvedValueOnce(json(200));
    vi.stubGlobal('fetch', fetch);
    const { client, deps } = makeRequestClient();

    await client.control(device, '0001', '1');

    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[1][1].headers.authorization).toBe('Bearer fresh');
  });

  it('retries a server error with backoff, then succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200)));
    const { client, deps } = makeRequestClient();

    await client.control(device, '0001', '1');

    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep.mock.calls[1][0]).toBeGreaterThan(deps.sleep.mock.calls[0][0]);
  });

  it('gives up after a bounded number of retries', async () => {
    const fetch = vi.fn().mockResolvedValue(json(500));
    vi.stubGlobal('fetch', fetch);
    const { client } = makeRequestClient();

    await expect(client.control(device, '0001', '1')).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request Coway rejected outright', async () => {
    const fetch = vi.fn().mockResolvedValue(json(400));
    vi.stubGlobal('fetch', fetch);
    const { client } = makeRequestClient();

    await expect(client.control(device, '0001', '1')).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sets a timeout on every request, so a hung connection cannot stall a poll', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200));
    vi.stubGlobal('fetch', fetch);
    const { client } = makeRequestClient();

    await client.control(device, '0001', '1');

    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reads filter supplies at most every 30 minutes, not on every poll', async () => {
    vi.useFakeTimers();
    const supplies = json(200, { data: { suppliesList: [{ supplyNm: 'Pre-Filter', filterRemain: 80 }] } });
    const fetch = vi.fn().mockResolvedValue(supplies);
    vi.stubGlobal('fetch', fetch);
    const { client } = makeRequestClient();

    expect(await client.fetchFilters(device)).toEqual([{ name: 'Pre-Filter', remainPct: 80 }]);
    expect(await client.fetchFilters(device)).toEqual([{ name: 'Pre-Filter', remainPct: 80 }]);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await client.fetchFilters(device);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
