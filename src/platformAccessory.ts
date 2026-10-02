import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { CowayClient, PurifierDevice } from './cowayClient.js';
import type { CowayPlatform } from './platform.js';
import {
  commandsFor, detectLightConvention, isLightOn, lightCommand,
  toAirQuality, toRotationSpeed, type Command, type LightConvention, type PurifierState,
} from './purifierState.js';
import { Attr, Mode } from './settings.js';

/** The optional mode switches, and the attribute value each selects. */
const MODE_SWITCHES = [
  { key: 'night', label: 'Night Mode', value: Mode.NIGHT, flag: 'nightMode' },
  { key: 'rapid', label: 'Rapid Mode', value: Mode.RAPID, flag: 'rapidMode' },
  { key: 'eco', label: 'Eco Mode', value: Mode.ECO, flag: 'ecoMode' },
] as const;

/**
 * One Airmega, exposed as an air purifier plus its air-quality sensor, whatever
 * filters the model actually reports, and optionally the panel light and the
 * modes HomeKit has no vocabulary for.
 *
 * Services that depend on hardware the model may not have are created lazily,
 * on the first poll that proves the capability exists. Publishing them eagerly
 * would show a filter permanently at 100% on a model that reports none — a
 * reassuring, wrong reading being worse than an absent one.
 */
export class AirmegaAccessory {
  private readonly purifier: Service;
  private readonly airQuality: Service;
  private light?: Service;
  private readonly modeSwitches = new Map<string, Service>();

  private state?: PurifierState;
  private lightConvention: LightConvention;

  constructor(
    private readonly platform: CowayPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: CowayClient,
    private readonly device: PurifierDevice,
  ) {
    const { Service, Characteristic } = platform;
    this.lightConvention = platform.config.lightConvention ?? 'onOff';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Coway')
      .setCharacteristic(Characteristic.Model, device.productModel)
      .setCharacteristic(Characteristic.SerialNumber, device.deviceSerial);

    this.purifier = this.accessory.getService(Service.AirPurifier)
      ?? this.accessory.addService(Service.AirPurifier, device.nickname);

    this.purifier.getCharacteristic(Characteristic.Active)
      .onGet(() => this.read((s) => (s.isOn ? 1 : 0), 0))
      .onSet((v) => this.send(Attr.POWER, v ? '1' : '0'));

    this.purifier.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() => this.read((s) => (s.isOn ? 2 : 0), 0));

    this.purifier.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => this.read((s) => (s.autoMode ? 1 : 0), 1))
      .onSet((v) => {
        const isOn = this.state?.isOn ?? false;
        return v === 1
          ? this.sendAll(commandsFor.mode(isOn, Mode.AUTO))
          // Leaving auto has no direct command; selecting a speed is what puts
          // the unit into manual, so re-assert the current one. A reported speed
          // of 0 must not pass through: speed 0 means power off.
          : this.sendAll(commandsFor.speed(isOn, toRotationSpeed(this.state?.fanSpeed || 1)));
      });

    this.purifier.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minStep: 33 })
      .onGet(() => this.read((s) => toRotationSpeed(s.fanSpeed), 0))
      .onSet((v) => this.sendAll(commandsFor.speed(this.state?.isOn ?? false, Number(v))));

    this.purifier.getCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.read((s) => (s.buttonLock ? 1 : 0), this.accessory.context.buttonLock ? 1 : 0))
      .onSet((v) => this.send(Attr.LOCK, v ? '1' : '0'));

    this.airQuality = this.accessory.getService(Service.AirQualitySensor)
      ?? this.accessory.addService(Service.AirQualitySensor, `${device.nickname} Air Quality`);
    this.airQuality.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.read((s) => toAirQuality(s.aqGrade), 0));

    if (platform.config.exposeLight) {
      this.light = this.accessory.getService(Service.Lightbulb)
        ?? this.accessory.addService(Service.Lightbulb, `${device.nickname} Light`);
      this.light.getCharacteristic(Characteristic.On)
        .onGet(() => this.read((s) => isLightOn(s.lightRaw, this.lightConvention), false))
        .onSet((v) => this.send(Attr.LIGHT, lightCommand(Boolean(v), this.lightConvention)));
    }

    if (platform.config.exposeModeSwitches) {
      for (const m of MODE_SWITCHES) {
        const svc = this.accessory.getServiceById(Service.Switch, m.key)
          ?? this.accessory.addService(Service.Switch, `${device.nickname} ${m.label}`, m.key);
        svc.getCharacteristic(Characteristic.On)
          .onGet(() => this.read((s) => Boolean(s[m.flag]), false))
          // Turning a mode off has no inverse command, so fall back to auto.
          .onSet((v) => this.sendAll(
            commandsFor.mode(this.state?.isOn ?? false, v ? m.value : Mode.AUTO)));
        this.modeSwitches.set(m.key, svc);
      }
    }
  }

  /** Create a filter service only once the device has proven it has that filter. */
  private filterService(label: string, subtype: string): Service {
    const { Service } = this.platform;
    return this.accessory.getServiceById(Service.FilterMaintenance, subtype)
      ?? this.accessory.addService(
        Service.FilterMaintenance, `${this.device.nickname} ${label}`, subtype);
  }

  private read<T extends CharacteristicValue>(pick: (s: PurifierState) => T, fallback: T): T {
    return this.state ? pick(this.state) : fallback;
  }

  /** Apply commands in order; Coway accepts only one attribute per call. */
  private async sendAll(commands: Command[]): Promise<void> {
    for (const c of commands) {
      await this.send(c.attribute, c.value);
    }
  }

  private async send(attribute: string, value: string): Promise<void> {
    try {
      await this.client.control(this.device, attribute, value);
    } catch (err) {
      // A plain error reaches HAP-NodeJS as an "unhandled error" with a stack
      // trace; a HapStatusError shows the tile as No Response without one.
      this.platform.log.error(`${this.device.nickname}: command failed: ${(err as Error).message}`);
      const { HapStatusError, HAPStatus } = this.platform.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.state) {
      return;
    }
    // Coway's status page lags a command, so update optimistically and let the
    // next poll correct us if it disagrees.
    if (attribute === Attr.POWER) {
      this.state.isOn = value === '1';
    }
    if (attribute === Attr.FAN_SPEED) {
      this.state.fanSpeed = Number(value);
      // A speed command takes the unit out of whichever mode it was in.
      this.state.autoMode = false;
      this.state.nightMode = false;
      this.state.rapidMode = false;
      this.state.ecoMode = false;
    }
    if (attribute === Attr.LIGHT) {
      this.state.lightRaw = Number(value);
    }
    if (attribute === Attr.LOCK) {
      this.state.buttonLock = value === '1';
      // Kept on the cached accessory for models that never report the lock.
      this.accessory.context.buttonLock = this.state.buttonLock;
    }
    if (attribute === Attr.MODE) {
      this.state.autoMode = value === Mode.AUTO || value === Mode.ECO;
      this.state.nightMode = value === Mode.NIGHT;
      this.state.rapidMode = value === Mode.RAPID;
      this.state.ecoMode = value === Mode.ECO;
    }
  }

  async refresh(): Promise<void> {
    const { Characteristic } = this.platform;
    try {
      const s = await this.client.readState(this.device);
      // Some models (the 400S) obey a lock command but never report lock state.
      // Hold the last value set, or the toggle snaps back to unlocked every poll.
      s.buttonLock ??= this.accessory.context.buttonLock ?? false;
      this.state = s;

      // A value only the enum convention can produce settles the ambiguity.
      const detected = detectLightConvention(s.lightRaw);
      if (detected && detected !== this.lightConvention) {
        this.lightConvention = detected;
        this.platform.log.info(
          `${this.device.nickname}: detected the "${detected}" panel-light convention.`);
      }

      this.purifier.updateCharacteristic(Characteristic.Active, s.isOn ? 1 : 0);
      this.purifier.updateCharacteristic(Characteristic.CurrentAirPurifierState, s.isOn ? 2 : 0);
      this.purifier.updateCharacteristic(Characteristic.TargetAirPurifierState, s.autoMode ? 1 : 0);
      this.purifier.updateCharacteristic(Characteristic.RotationSpeed, toRotationSpeed(s.fanSpeed));
      this.purifier.updateCharacteristic(Characteristic.LockPhysicalControls, s.buttonLock ? 1 : 0);

      this.airQuality.updateCharacteristic(Characteristic.AirQuality, toAirQuality(s.aqGrade));
      // Only publish a pollutant the model actually measures; a constant 0
      // would read as pristine air.
      if (s.pm10 !== undefined) {
        this.airQuality.updateCharacteristic(Characteristic.PM10Density, s.pm10);
      }
      if (s.pm25 !== undefined) {
        this.airQuality.updateCharacteristic(Characteristic.PM2_5Density, s.pm25);
      }

      this.updateFilter('Pre-Filter', 'pre-filter', s.preFilterPct);
      this.updateFilter('Max2 Filter', 'max2-filter', s.max2Pct);
      this.updateFilter('Odor Filter', 'odor-filter', s.odorFilterPct);

      this.light?.updateCharacteristic(
        Characteristic.On, isLightOn(s.lightRaw, this.lightConvention));
      for (const m of MODE_SWITCHES) {
        this.modeSwitches.get(m.key)?.updateCharacteristic(Characteristic.On, Boolean(s[m.flag]));
      }
    } catch (err) {
      this.platform.log.debug(`Poll failed for ${this.device.nickname}: ${(err as Error).message}`);
    }
  }

  private updateFilter(label: string, subtype: string, pct: number | undefined): void {
    if (pct === undefined) {
      return;
    } // Model does not report this filter.
    const { Characteristic } = this.platform;
    const svc = this.filterService(label, subtype);
    svc.updateCharacteristic(Characteristic.FilterLifeLevel, pct);
    svc.updateCharacteristic(Characteristic.FilterChangeIndication, pct <= 0 ? 1 : 0);
  }
}
