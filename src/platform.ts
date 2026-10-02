import type {
  API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { CowayClient, type PurifierDevice } from './cowayClient.js';
import { CowayAuthError, PasswordExpiredError, RateLimitedError } from './errors.js';
import { AirmegaAccessory } from './platformAccessory.js';
import {
  DEFAULT_POLL_INTERVAL_S, MAX_DISCOVERY_RETRY_S, MIN_POLL_INTERVAL_S, PLATFORM_NAME, PLUGIN_NAME,
} from './settings.js';

interface CowayConfig extends PlatformConfig {
  username?: string;
  password?: string;
  skipPasswordChange?: boolean;
  pollIntervalSeconds?: number;
  exposeLight?: boolean;
  exposeModeSwitches?: boolean;
  lightConvention?: 'onOff' | 'mode';
}

export class CowayPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly client?: CowayClient;
  private readonly pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private discoveryAttempts = 0;
  private polling = false;
  private readonly managed: AirmegaAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: CowayConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Coway polls are several HTTPS round-trips each; a fast interval both
    // wastes the account's rate budget and slows every HomeKit read.
    // A hand-edited config can hold anything; setInterval(NaN) fires every 1ms.
    let requested = Number(config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_S);
    if (!Number.isFinite(requested)) {
      log.warn(`Ignoring pollIntervalSeconds "${config.pollIntervalSeconds}"; using ${DEFAULT_POLL_INTERVAL_S}s.`);
      requested = DEFAULT_POLL_INTERVAL_S;
    }
    this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_S, requested) * 1000;

    if (!config.username || !config.password) {
      this.log.error('No Coway IoCare username/password configured; the platform will stay idle.');
      return;
    }
    this.client = new CowayClient(config.username, config.password, undefined, {
      skipPasswordChange: config.skipPasswordChange ?? true,
    });

    api.on('didFinishLaunching', () => void this.discover());
    api.on('shutdown', () => {
      clearInterval(this.timer);
      clearTimeout(this.retryTimer);
    });
  }

  /** Homebridge replays cached accessories from disk before launching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private async discover(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    // Reached through api.hap rather than imported: homebridge is a
    // devDependency, so importing a value from it is not runtime-safe.
    const purifierCategory = this.api.hap.Categories.AIR_PURIFIER;

    let devices: PurifierDevice[];
    try {
      devices = await client.listPurifiers();
    } catch (err) {
      this.log.error(`Could not list Coway devices: ${(err as Error).message}`);
      if (err instanceof RateLimitedError || err instanceof CowayAuthError
        || err instanceof PasswordExpiredError) {
        // Another attempt cannot succeed and would count towards a lockout.
        this.log.error('Not retrying until Homebridge restarts.');
        return;
      }
      // Usually a network blip or a Coway outage at boot: back off and retry,
      // rather than leaving cached accessories unwired until a manual restart.
      const delayMs = Math.min(
        this.pollIntervalMs * 2 ** this.discoveryAttempts++, MAX_DISCOVERY_RETRY_S * 1000);
      this.log.warn(`Retrying device discovery in ${Math.round(delayMs / 1000)}s.`);
      this.retryTimer = setTimeout(() => void this.discover(), delayMs);
      return;
    }
    // Coway can list one purifier under more than one place; registering the
    // same UUID twice throws.
    devices = [...new Map(devices.map((d) => [d.deviceSerial, d])).values()];

    if (!devices.length) {
      this.log.warn('No air purifiers found on this Coway account.');
      return;
    }

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceSerial);
      const existing = this.accessories.find((a) => a.UUID === uuid);

      if (existing) {
        existing.context.device = device;
        // Accessories cached before this was set carry Categories.OTHER, which
        // HomeKit draws with a generic icon. Correcting it here fixes existing
        // installs on restart, without needing to re-pair.
        if (existing.category !== purifierCategory) {
          existing.category = purifierCategory;
          this.api.updatePlatformAccessories([existing]);
        }
        this.managed.push(new AirmegaAccessory(this, existing, client, device));
        this.log.info(`Restored ${device.nickname}`);
      } else {
        // Without an explicit category HomeKit falls back to a generic icon.
        const accessory = new this.api.platformAccessory(
          device.nickname, uuid, purifierCategory);
        accessory.context.device = device;
        this.managed.push(new AirmegaAccessory(this, accessory, client, device));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${device.nickname} (${device.productModel})`);
      }
    }

    // Drop accessories for purifiers no longer on the account.
    const live = new Set(devices.map((d) => this.api.hap.uuid.generate(d.deviceSerial)));
    const stale = this.accessories.filter((a) => !live.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} purifier(s) no longer on the account.`);
    }

    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  /** One cloud read per device per tick, shared by all of its characteristics. */
  private async poll(): Promise<void> {
    // A slow Coway can outlast the interval; overlapping polls only add load.
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const accessory of this.managed) {
        await accessory.refresh();
      }
    } finally {
      this.polling = false;
    }
  }
}
