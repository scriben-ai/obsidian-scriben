import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinceLabel, connectionSummary, syncNotice, syncIntervalMs, SYNC_CHOICES } from '../src/human.mjs';

/**
 * The plugin used to say "Connected" and nothing else, and a finished sync said
 * "0 updated, 12 already current" — which reads like a database log, not an
 * answer to the only question a user has: is this working?
 *
 * These are the strings a person actually reads, so they are tested. A wrong
 * "5 minutes ago" makes a working plugin look broken, and nothing in a type
 * checker or a build catches it.
 */

test('a plugin that has never synced says so, rather than showing a fake timestamp', () => {
  assert.equal(sinceLabel(0), 'never');
  assert.equal(sinceLabel(undefined), 'never');
  assert.equal(connectionSummary({ account: 'a@b.com' }), 'Connected as a@b.com. No meetings synced yet.');
});

test('elapsed time is whole units, because "1.4 hours ago" reads like a machine', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const ago = (ms) => sinceLabel(now - ms, now);
  assert.equal(ago(5_000), 'just now');
  assert.equal(ago(60_000), '1 minute ago');
  assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(60 * 60_000), '1 hour ago');
  assert.equal(ago(5 * 3600_000), '5 hours ago');
  assert.equal(ago(25 * 3600_000), 'yesterday');
  assert.equal(ago(3 * 24 * 3600_000), '3 days ago');
});

test('the connection line answers "is it working" without a Test button', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const line = connectionSummary(
    { account: 'agam@scriben.ai', lastSyncAt: now - 300_000, lastSyncCount: 23 }, now);
  assert.equal(line, 'Connected as agam@scriben.ai · 23 meeting notes in this vault · last synced 5 minutes ago');
});

test('one note is not "1 notes"', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  assert.match(connectionSummary({ lastSyncAt: now - 1000, lastSyncCount: 1 }, now), /1 meeting note /);
  assert.equal(syncNotice(1, false), 'Scriben: 1 new meeting note.');
  assert.equal(syncNotice(3, false), 'Scriben: 3 new meeting notes.');
});

test('a background sync that found nothing stays silent', () => {
  assert.equal(syncNotice(0, true), null, 'auto-sync must not pop a notice every hour saying nothing happened');
  assert.equal(syncNotice(0, false), 'Scriben: your meetings are up to date.');
  assert.equal(syncNotice(2, true), 'Scriben: 2 new meeting notes.', 'new notes are worth interrupting for');
});

/**
 * A saved settings file is not trusted input: it survives downgrades, hand
 * edits and sync conflicts. A 0 here would spin a request loop against the
 * server, and a NaN makes setInterval fire continuously.
 */
test('a corrupt interval cannot turn into a request loop', () => {
  assert.equal(syncIntervalMs(60), 3_600_000);
  assert.equal(syncIntervalMs(0), 15 * 60_000, 'clamped up to the minimum');
  assert.equal(syncIntervalMs(-5), 15 * 60_000);
  assert.equal(syncIntervalMs(NaN), 60 * 60_000, 'falls back to the default');
  assert.equal(syncIntervalMs('nonsense'), 60 * 60_000);
  assert.equal(syncIntervalMs(99999), 1440 * 60_000, 'clamped to a day');
});

test('every offered interval survives the clamp unchanged', () => {
  for (const m of SYNC_CHOICES) assert.equal(syncIntervalMs(m), m * 60_000, `${m} minutes`);
});
