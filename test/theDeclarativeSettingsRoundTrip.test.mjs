import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlValue, applyControlValue } from '../src/settingsBridge.mjs';

/**
 * On Obsidian 1.13+ the settings tab is rendered from getSettingDefinitions() and
 * display() is never called — so this conversion IS the settings tab for most
 * users, and it is the one path that cannot be exercised by running the plugin
 * on an older build. Everything it does is pinned here instead.
 *
 * The failure it guards against is not cosmetic. Settings is the only way anyone
 * connects the plugin; a folder list that round-trips wrong either shares nothing
 * or shares the wrong folders.
 */

const fresh = () => ({
  notesFolder: 'Scriben', syncOnStartup: true, autoSync: false,
  autoSyncMinutes: 60, shareBack: false, sharedFolders: [],
});

test('shared folders survive the trip through a textarea', () => {
  const s = fresh();
  s.sharedFolders = ['Meetings', 'Clients/Acme'];
  assert.equal(controlValue(s, 'sharedFolders'), 'Meetings\nClients/Acme');

  applyControlValue(s, 'sharedFolders', 'Meetings\nClients/Acme\n');
  assert.deepEqual(s.sharedFolders, ['Meetings', 'Clients/Acme'],
    'a trailing newline must not become an empty folder name');
});

test('blank lines and stray spaces never become a shared folder', () => {
  const s = fresh();
  applyControlValue(s, 'sharedFolders', '  Meetings  \n\n\n   \nWork/1:1s\n');
  assert.deepEqual(s.sharedFolders, ['Meetings', 'Work/1:1s']);
  // An empty entry here would be the difference between sharing named folders
  // and sharing nothing, silently.
  applyControlValue(s, 'sharedFolders', '');
  assert.deepEqual(s.sharedFolders, []);
});

test('the interval reaches the dropdown as a string, or nothing looks selected', () => {
  const s = fresh();
  assert.equal(controlValue(s, 'autoSyncMinutes'), '60');
  assert.strictEqual(typeof controlValue(s, 'autoSyncMinutes'), 'string');

  applyControlValue(s, 'autoSyncMinutes', '180');
  assert.strictEqual(s.autoSyncMinutes, 180, 'and comes back as a number we can multiply');
});

test('a change that affects the background timer says so', () => {
  const s = fresh();
  assert.equal(applyControlValue(s, 'autoSync', true).restartTimer, true);
  assert.equal(applyControlValue(s, 'autoSyncMinutes', '15').restartTimer, true);
  assert.equal(applyControlValue(s, 'notesFolder', 'Meetings').restartTimer, false);
  assert.equal(applyControlValue(s, 'shareBack', true).restartTimer, false);
});

test('an emptied folder name falls back rather than filing notes at the vault root', () => {
  const s = fresh();
  applyControlValue(s, 'notesFolder', '   ');
  assert.equal(s.notesFolder, 'Scriben');
  applyControlValue(s, 'notesFolder', '  Meetings  ');
  assert.equal(s.notesFolder, 'Meetings');
});

test('an unknown key is not written into the settings file', () => {
  const s = fresh();
  const before = JSON.stringify(s);
  const out = applyControlValue(s, 'somethingElse', 'x');
  assert.equal(out.changed, false);
  assert.equal(JSON.stringify(s), before);
});

test('toggles round-trip as booleans', () => {
  const s = fresh();
  for (const key of ['syncOnStartup', 'autoSync', 'shareBack']) {
    applyControlValue(s, key, true);
    assert.strictEqual(controlValue(s, key), true, key);
    applyControlValue(s, key, false);
    assert.strictEqual(controlValue(s, key), false, key);
  }
});
