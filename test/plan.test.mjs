/**
 * The read direction is the one that can leak a vault, so most of this file is
 * about what does NOT get sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPull, planPush, noteHash } from '../src/plan.mjs';

const n = (ref, title) => ({ ref, title, date: '2026-09-06T10:00:00Z', participants: [] });

test('a first sync writes every note', () => {
  const { write, skip } = planPull([n('a', 'One'), n('b', 'Two')]);
  assert.equal(write.length, 2);
  assert.equal(skip.length, 0);
});

test('an unchanged note is skipped, so a sync does not touch every file', () => {
  const note = n('a', 'One');
  const h = noteHash(note);
  const { write, skip } = planPull([note], new Map([['a', { path: 'x.md', hash: h }]]), new Map([['a', h]]));
  assert.equal(write.length, 0);
  assert.deepEqual(skip, [{ ref: 'a', path: 'x.md' }]);
});

test('a CHANGED note is rewritten in place', () => {
  const note = n('a', 'One');
  const { write } = planPull([note], new Map([['a', { path: 'old.md', hash: 'stale' }]]),
    new Map([['a', noteHash(note)]]));
  assert.equal(write.length, 1);
  assert.equal(write[0].path, 'old.md');
});

test('a retitled note keeps its old path, because renaming breaks every wikilink to it', () => {
  const renamed = n('a', 'A completely different title');
  const { write } = planPull([renamed], new Map([['a', { path: '2026-09-06 One a.md', hash: 'stale' }]]),
    new Map([['a', noteHash(renamed)]]));
  assert.equal(write[0].path, '2026-09-06 One a.md');
});

test('the same note twice in one payload is filed once', () => {
  const { write } = planPull([n('a', 'One'), n('a', 'One again')]);
  assert.equal(write.length, 1);
});

test('a note with no ref is dropped rather than filed as undefined.md', () => {
  const { write } = planPull([{ title: 'orphan' }]);
  assert.equal(write.length, 0);
});

// ---------------------------------------------------------------- read side

test('THE PRIVACY RULE: nothing outside the shared folders is ever sent', () => {
  const { send, skipped } = planPush([
    { path: 'Meetings/one.md', body: 'shareable' },
    { path: 'Journal/2026-09-06.md', body: 'private' },
    { path: 'Medical/results.md', body: 'very private' },
  ], { folders: ['Meetings'] });
  assert.deepEqual(send.map((s) => s.path), ['Meetings/one.md']);
  assert.deepEqual(skipped.map((s) => s.why).sort(), ['outside-shared-folders', 'outside-shared-folders']);
});

test('a folder name that is a PREFIX of another is not treated as that other', () => {
  const { send } = planPush([{ path: 'MeetingsPrivate/x.md', body: 'b' }], { folders: ['Meetings'] });
  assert.equal(send.length, 0, 'MeetingsPrivate/ was matched by the Meetings/ allowlist');
});

test('no folders configured means nothing is sent, not everything', () => {
  const { send } = planPush([{ path: 'a.md', body: 'b' }], { folders: [] });
  assert.equal(send.length, 0);
});

test('non-markdown, empty and oversized files are left alone', () => {
  const { send, skipped } = planPush([
    { path: 'Meetings/a.png', body: 'x' },
    { path: 'Meetings/b.md', body: '   ' },
    { path: 'Meetings/c.md', body: 'x'.repeat(300000) },
  ], { folders: ['Meetings'] });
  assert.equal(send.length, 0);
  assert.deepEqual(skipped.map((s) => s.why), ['not-markdown', 'empty', 'too-large']);
});

test('an unchanged file is not re-sent on every sweep', () => {
  const first = planPush([{ path: 'Meetings/a.md', body: 'hello' }], { folders: ['Meetings'] });
  const sent = new Map([[first.send[0].path, first.send[0].hash]]);
  const again = planPush([{ path: 'Meetings/a.md', body: 'hello' }], { folders: ['Meetings'], sent });
  assert.equal(again.send.length, 0);
  assert.equal(again.skipped[0].why, 'unchanged');
});
