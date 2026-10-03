import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Rules the Homebridge verification checker enforces on the published files.
const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('package.json', () => {
  it('declares the transports it publishes over', () => {
    const { keywords } = read('package.json');
    expect(keywords).toContain('homebridge-plugin');
    expect(keywords).toContain('supports-hap');
    // HAP accessories only; Homebridge bridges them to Matter itself.
    expect(keywords).not.toContain('supports-matter');
  });
});

describe('config.schema.json', () => {
  const { schema } = read('config.schema.json');

  it('lists required fields at the object level, as JSON Schema expects', () => {
    expect(schema.required).toEqual(['name', 'username', 'password']);
    for (const [key, property] of Object.entries(schema.properties)) {
      expect((property as Record<string, unknown>).required, key).toBeUndefined();
    }
  });

  it('only requires fields it defines', () => {
    for (const key of schema.required) {
      expect(schema.properties).toHaveProperty(key);
    }
  });
});
