import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * versions.json is the map Obsidian reads when the user's app is older than the
 * current manifest's minAppVersion: it hands them the newest plugin version whose
 * required app version they satisfy.
 *
 * It listed only 0.1.0 against the 1.2.3 floor, so every user below Obsidian
 * 1.13 was offered 0.1.0 — the build from BEFORE 0.1.1 stopped the plugin
 * reading files outside the folders the user had shared. 0.1.1 and 0.1.2 carry
 * the same 1.2.3 floor, so naming the newest of them costs nothing and is the
 * difference between shipping that fix to those users and not.
 *
 * Obsidian's docs say you only need an entry when minAppVersion CHANGES, which
 * is why this was easy to miss: the file was valid, and quietly wrong.
 */
const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

test('a user below the current floor is not sent back before the vault-scoping fix', () => {
  const offered = Object.entries(versions)
    .filter(([, needs]) => cmp(needs, '1.13.0') < 0)
    .map(([v]) => v)
    .sort(cmp)
    .pop();
  assert.ok(offered, 'versions.json offers nothing at all to an app below 1.13.0');
  assert.ok(cmp(offered, '0.1.2') >= 0,
    `an app below 1.13.0 would be offered ${offered}; 0.1.1 is where the plugin stopped `
    + 'reading unshared files, so anything below 0.1.2 hands them that bug');
});

test('every listed floor is one the plugin actually shipped', () => {
  for (const [v, needs] of Object.entries(versions)) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${v} is not a plugin version`);
    assert.match(needs, /^\d+\.\d+\.\d+$/, `${v} maps to ${needs}, not an app version`);
  }
});
