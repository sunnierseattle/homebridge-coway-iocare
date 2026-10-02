import * as hap from '@homebridge/hap-nodejs';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/** A PlatformAccessory stand-in: a HAP accessory plus the context Homebridge persists. */
export class FakePlatformAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
  constructor(displayName: string, uuid: string, public category?: number) {
    super(displayName, uuid);
  }
}

export function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Just enough of Homebridge's API for the platform: lifecycle events, hap, registration. */
export function makeApi() {
  const events = new EventEmitter();
  return {
    hap,
    on: (event: string, listener: () => void) => events.on(event, listener),
    emit: (event: string) => events.emit(event),
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  };
}
