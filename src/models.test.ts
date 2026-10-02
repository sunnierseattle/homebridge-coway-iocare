import { describe, expect, it } from 'vitest';

import { profileFor } from './models.js';

describe('profileFor', () => {
  it('recognises a model by Coway\'s product name when the model code is new', () => {
    expect(profileFor('AP-1999Z', 'Airmega 250S')).toMatchObject({ light: 'mode', modes: ['night', 'rapid'] });
  });

  it('falls back to the model code', () => {
    expect(profileFor('AP-1719A')).toMatchObject({ light: 'mode' });
  });

  it('matches product names regardless of case', () => {
    expect(profileFor('AP-1999Z', 'AIRMEGA ICONS')).toMatchObject({ light: 'mode', modes: ['night'] });
  });

  it('knows nothing about an unrecognised model', () => {
    expect(profileFor('AP-1999Z', 'Airmega 9000')).toBeUndefined();
  });
});
