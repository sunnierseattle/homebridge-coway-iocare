import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The release workflow publishes nothing unless this script finds notes for the tag.
const script = fileURLToPath(new URL('../scripts/release-notes.sh', import.meta.url));

function run(changelog: string, tag: string, mode?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  const args = mode ? [script, tag, mode] : [script, tag];
  return spawnSync('sh', args, { cwd: dir, encoding: 'utf8' });
}

const changelog = `# Changelog

## v1.5.0 — Faster polling

- Polls in parallel.

## v1.4.0 — Sleep on the speed slider

Body of 1.4.0.

### A subheading stays inside the section
`;

describe('scripts/release-notes.sh', () => {
  it('prints the body of the section for the tag', () => {
    const out = run(changelog, 'v1.4.0');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('Body of 1.4.0.\n\n### A subheading stays inside the section');
  });

  it('stops at the next version heading', () => {
    expect(run(changelog, 'v1.5.0').stdout.trim()).toBe('- Polls in parallel.');
  });

  it('keeps a body heading that is not a version inside the section', () => {
    const out = run('## v3.0.0 — Big\n\n## What changed\n\nLots.\n\n## v2.0.0 — Old\n\nx\n', 'v3.0.0');
    expect(out.stdout.trim()).toBe('## What changed\n\nLots.');
  });

  it('prints the title from the heading', () => {
    const out = run(changelog, 'v1.4.0', '--title');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('v1.4.0 — Sleep on the speed slider');
  });

  it('fails when the tag has no section, so nothing is released without notes', () => {
    const out = run(changelog, 'v9.9.9');
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/v9\.9\.9/);
  });

  it('fails when the section is empty', () => {
    const out = run('## v2.0.0 — Nothing yet\n\n   \n## v1.0.0 — Old\n\nx\n', 'v2.0.0');
    expect(out.status).not.toBe(0);
  });

  it('does not match a version that merely starts with the tag', () => {
    expect(run('## v1.4.10 — Later\n\nTen.\n', 'v1.4.1').status).not.toBe(0);
  });
});
