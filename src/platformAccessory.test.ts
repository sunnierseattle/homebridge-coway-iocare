import * as hap from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';

import type { CowayClient, PurifierDevice } from './cowayClient.js';
import type { CowayPlatform } from './platform.js';
import { AirmegaAccessory } from './platformAccessory.js';

const device = {
  nickname: 'Bedroom', productModel: 'AP-2015E', deviceSerial: 'SERIAL1',
} as PurifierDevice;

function makeAccessory(control: CowayClient['control']) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const platform = {
    Service: hap.Service, Characteristic: hap.Characteristic, api: { hap }, config: {}, log,
  } as unknown as CowayPlatform;
  const accessory = Object.assign(
    new hap.Accessory(device.nickname, hap.uuid.generate(device.deviceSerial)), { context: {} });
  const client = { control: vi.fn(control) } as unknown as CowayClient;
  new AirmegaAccessory(platform, accessory as never, client, device);
  const active = accessory.getService(hap.Service.AirPurifier)!.getCharacteristic(hap.Characteristic.Active);
  const warnings: string[] = [];
  active.on(hap.CharacteristicEventTypes.CHARACTERISTIC_WARNING, (_type, message) => warnings.push(message));
  return { active, log, warnings };
}

describe('AirmegaAccessory commands', () => {
  it('reports a failed cloud command to HomeKit as a communication failure, not an unhandled error', async () => {
    const { active, log, warnings } = makeAccessory(() => Promise.reject(new Error('socket hang up')));

    await expect(active.handleSetRequest(1)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    expect(warnings).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('resolves when the cloud accepts the command', async () => {
    const { active, warnings } = makeAccessory(() => Promise.resolve());

    await expect(active.handleSetRequest(1)).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
