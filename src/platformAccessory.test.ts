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

describe('AirmegaAccessory readings', () => {
  it('shows the top fan speed as 100%, not 99%', async () => {
    const { airmega, purifier } = makeAccessory({ readState: () => Promise.resolve(state({ fanSpeed: 3 })) });
    await airmega.refresh();
    expect(purifier.getCharacteristic(hap.Characteristic.RotationSpeed).value).toBe(100);
  });

  it.each([{ pct: 9, indication: 1 }, { pct: 10, indication: 0 }, { pct: 50, indication: 0 }])(
    'asks for a filter change below 10% life left ($pct% -> $indication)',
    async ({ pct, indication }) => {
      const { airmega, accessory } = makeAccessory({
        readState: () => Promise.resolve(state({ preFilterPct: pct })),
      });
      await airmega.refresh();
      const filter = accessory.getServiceById(hap.Service.FilterMaintenance, 'pre-filter')!;
      expect(filter.getCharacteristic(hap.Characteristic.FilterChangeIndication).value).toBe(indication);
    });
});

describe('AirmegaAccessory naming', () => {
  it('names each extra tile, so Home does not label them all with the purifier\'s name', async () => {
    const { airmega, accessory } = makeAccessory(
      { readState: () => Promise.resolve(state({ preFilterPct: 80 })) }, { exposeLight: true });
    await airmega.refresh();

    const name = (svc: hap.Service | undefined) => svc?.getCharacteristic(hap.Characteristic.ConfiguredName).value;
    expect(name(accessory.getService(hap.Service.AirQualitySensor))).toBe('Bedroom Air Quality');
    expect(name(accessory.getService(hap.Service.Lightbulb))).toBe('Bedroom Light');
    expect(name(accessory.getServiceById(hap.Service.FilterMaintenance, 'pre-filter'))).toBe('Bedroom Pre-Filter');
  });

  it('keeps a name the user changed in the Home app', () => {
    const first = makeAccessory();
    const aq = first.accessory.getService(hap.Service.AirQualitySensor)!;
    aq.setCharacteristic(hap.Characteristic.ConfiguredName, 'Nursery Air');

    // Restored from the cache on the next launch.
    new AirmegaAccessory(
      { Service: hap.Service, Characteristic: hap.Characteristic, api: { hap }, config: {}, log: makeLog() } as never,
      first.accessory as never, first.client as never, device);
    expect(aq.getCharacteristic(hap.Characteristic.ConfiguredName).value).toBe('Nursery Air');
  });

  it('marks the purifier as the primary service', () => {
    const { purifier } = makeAccessory();
    expect(purifier.isPrimaryService).toBe(true);
  });

  it('reports the purifier\'s firmware version', async () => {
    const { airmega, accessory } = makeAccessory({ readState: () => Promise.resolve(state({ firmware: '1.0.0' })) });
    await airmega.refresh();
    const info = accessory.getService(hap.Service.AccessoryInformation)!;
    expect(info.getCharacteristic(hap.Characteristic.FirmwareRevision).value).toBe('1.0.0');
  });
});
