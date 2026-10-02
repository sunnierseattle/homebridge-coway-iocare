import * as hap from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';

import type { CowayClient, PurifierDevice } from './cowayClient.js';
import { FakePlatformAccessory, makeLog } from './homebridge.harness.js';
import type { CowayPlatform } from './platform.js';
import { AirmegaAccessory } from './platformAccessory.js';
import type { PurifierState } from './purifierState.js';

const device = {
  nickname: 'Bedroom', productModel: 'AP-2015E', deviceSerial: 'SERIAL1',
} as PurifierDevice;

const state = (overrides: Partial<PurifierState> = {}): PurifierState => ({
  isOn: true, autoMode: false, nightMode: false, rapidMode: false, ecoMode: false,
  fanSpeed: 2, online: true, ...overrides,
});

function makeAccessory(
  client: Partial<Record<keyof CowayClient, (...args: never[]) => unknown>> = {},
  config: Record<string, unknown> = {},
  dev: PurifierDevice = device,
) {
  const log = makeLog();
  const platform = {
    Service: hap.Service, Characteristic: hap.Characteristic, api: { hap }, config, log,
  } as unknown as CowayPlatform;
  const accessory = new FakePlatformAccessory(dev.nickname, hap.uuid.generate(dev.deviceSerial));
  const doubles = {
    control: vi.fn(() => Promise.resolve()),
    readState: vi.fn(() => Promise.resolve(state())),
    ...client,
  };
  const airmega = new AirmegaAccessory(platform, accessory as never, doubles as unknown as CowayClient, dev);
  const purifier = accessory.getService(hap.Service.AirPurifier)!;
  const active = purifier.getCharacteristic(hap.Characteristic.Active);
  const warnings: string[] = [];
  active.on(hap.CharacteristicEventTypes.CHARACTERISTIC_WARNING, (_type, message) => warnings.push(message));
  return { airmega, accessory, purifier, active, log, warnings, client: doubles };
}

describe('AirmegaAccessory commands', () => {
  it('reports a failed cloud command to HomeKit as a communication failure, not an unhandled error', async () => {
    const { active, log, warnings } = makeAccessory({ control: () => Promise.reject(new Error('socket hang up')) });

    await expect(active.handleSetRequest(1)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    expect(warnings).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('resolves when the cloud accepts the command', async () => {
    const { active, warnings } = makeAccessory();

    await expect(active.handleSetRequest(1)).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('AirmegaAccessory polling', () => {
  it('warns after repeated poll failures, not on the first, and says when it recovers', async () => {
    const readState = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(state());
    const { airmega, log } = makeAccessory({ readState });

    await airmega.refresh();
    await airmega.refresh();
    expect(log.warn).not.toHaveBeenCalled();
    await airmega.refresh();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));

    await airmega.refresh();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/reachable again/i));
  });

  it('shows No Response while Coway reports the purifier offline', async () => {
    const { airmega, active } = makeAccessory({ readState: () => Promise.resolve(state({ online: false })) });

    await airmega.refresh();

    await expect(active.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('answers normally again once the purifier is back online', async () => {
    const readState = vi.fn()
      .mockResolvedValueOnce(state({ online: false }))
      .mockResolvedValue(state({ isOn: true }));
    const { airmega, active } = makeAccessory({ readState });

    await airmega.refresh();
    await airmega.refresh();

    await expect(active.handleGetRequest()).resolves.toBe(1);
  });
});
