import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PurifierDevice } from './cowayClient.js';
import { CowayAuthError, RateLimitedError } from './errors.js';
import { makeApi, makeLog } from './homebridge.harness.js';
import { CowayPlatform } from './platform.js';

const client = {
  listPurifiers: vi.fn<() => Promise<PurifierDevice[]>>(),
  readState: vi.fn(),
  control: vi.fn(),
};
// A constructor that hands back the shared double, so tests can steer it.
vi.mock('./cowayClient.js', () => ({ CowayClient: class {
  constructor() {
    return client;
  }
} }));

const device = (serial: string): PurifierDevice => ({
  deviceSerial: serial, nickname: `Purifier ${serial}`, placeId: 'P', modelCode: 'M', productModel: 'AP-2015E',
});

function start(config: Record<string, unknown> = {}) {
  const api = makeApi();
  const log = makeLog();
  new CowayPlatform(log as never, { platform: 'CowayAirmega', username: 'u', password: 'p', ...config }, api as never);
  api.emit('didFinishLaunching');
  return { api, log };
}

describe('CowayPlatform', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    client.readState.mockRejectedValue(new Error('not under test'));
  });
  afterEach(() => vi.useRealTimers());

  it('retries discovery with growing delays when Coway is unreachable at startup', async () => {
    client.listPurifiers
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue([device('A')]);
    const { api } = start();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listPurifiers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.listPurifiers).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.listPurifiers).toHaveBeenCalledTimes(2); // second wait is longer
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.listPurifiers).toHaveBeenCalledTimes(3);
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rate-limited', new RateLimitedError('blocked')],
    ['refused the credentials', new CowayAuthError('bad password')],
  ])('stops retrying discovery once Coway has %s', async (_, error) => {
    client.listPurifiers.mockRejectedValue(error);
    const { log } = start();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(client.listPurifiers).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });

  it('stops a pending discovery retry when Homebridge shuts down', async () => {
    client.listPurifiers.mockRejectedValue(new Error('fetch failed'));
    const { api } = start();
    await vi.advanceTimersByTimeAsync(0);

    api.emit('shutdown');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(client.listPurifiers).toHaveBeenCalledTimes(1);
  });

  it('registers a purifier once even if Coway lists it under two places', async () => {
    client.listPurifiers.mockResolvedValue([device('A'), device('A')]);
    const { api } = start();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(api.registerPlatformAccessories.mock.calls[0][2]).toHaveLength(1);
  });

  it.each([['abc'], [null], [Number.NaN]])(
    'falls back to the default poll interval for an unusable value (%s)',
    async (value) => {
      client.listPurifiers.mockResolvedValue([device('A')]);
      const { log } = start({ pollIntervalSeconds: value });
      await vi.advanceTimersByTimeAsync(0);
      client.readState.mockClear();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(client.readState).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.readState).toHaveBeenCalledTimes(1);
      if (value !== null) {
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pollIntervalSeconds'));
      }
    });

  it('skips a poll while the previous one is still running', async () => {
    client.listPurifiers.mockResolvedValue([device('A')]);
    client.readState
      .mockRejectedValueOnce(new Error('first poll settles'))
      .mockImplementation(() => new Promise(() => {})); // later polls hang
    start({ pollIntervalSeconds: 30 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(client.readState).toHaveBeenCalledTimes(2);
  });
});
