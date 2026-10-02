import type { LightConvention, ModeSwitchKey } from './purifierState.js';

export type { ModeSwitchKey };

export interface ModelProfile {
  name: string;
  /** How the model encodes the panel light; see isLightOn. */
  light: LightConvention;
  /** The modes beyond Auto and Manual that the model accepts. */
  modes: ModeSwitchKey[];
}

/**
 * Profiles by Coway's product name, which is how home-assistant-iocare tells
 * models apart. It survives new model codes for the same product, which a code
 * table does not (AP-1720G is a 250S that no code table knew).
 */
const BY_NAME: Record<string, ModelProfile> = {
  'airmega 400s': { name: 'Airmega 400S', light: 'onOff', modes: ['night'] },
  'airmega 250s': { name: 'Airmega 250S', light: 'mode', modes: ['night', 'rapid'] },
  'airmega icons': { name: 'Airmega IconS', light: 'mode', modes: ['night'] },
};

/**
 * What each known model supports, keyed by Coway's productModel. Only the 400S
 * row is verified on hardware; the rest follow cowayaio and home-assistant-iocare,
 * plus model codes users of other plugins have reported. A model missing from
 * here gets every switch and the auto-detected light convention, since a
 * capability we cannot rule out is better offered than hidden.
 */
const MODELS: Record<string, ModelProfile> = {
  'AP-2015E': { name: 'Airmega 400S', light: 'onOff', modes: ['night'] },
  'AP-1521E': { name: 'Airmega 300S', light: 'onOff', modes: ['night'] },
  'AP-1515G': { name: 'Airmega 300S', light: 'onOff', modes: ['night'] },
  'AP-1512HHS': { name: 'Airmega AP-1512HHS', light: 'onOff', modes: ['eco'] },
  'AP-1719A': { name: 'Airmega 250S', light: 'mode', modes: ['night', 'rapid'] },
  'AP-1720G': { name: 'Airmega 250S', light: 'mode', modes: ['night', 'rapid'] },
  'AP-1722B': { name: 'Airmega IconS', light: 'mode', modes: ['night'] },
};

export function profileFor(productModel: string, productName?: string): ModelProfile | undefined {
  return (productName && BY_NAME[productName.trim().toLowerCase()]) || MODELS[productModel];
}
