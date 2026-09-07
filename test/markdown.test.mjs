/**
 * The two ways a sync plugin destroys trust: it eats what the user wrote, or it
 * files the same meeting twice. Both are here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFor, frontMatter, managedBody, mergeIntoExisting, userRegion, BEGIN, END }
  from '../src/markdown.mjs';

const note = {
  ref: 'n_4cafbe9bea0e',
  title: 'Pricing review with Northwind',
  date: '2026-09-06T14:44:00.618Z',
  type: 'Pricing review',
  participants: ['Daniel Okafor', 'Lena Fischer'],
};

test('the filename carries the ref, so one meeting is one file', () => {
  assert.equal(fileNameFor(note), '2026-09-06 Pricing review with Northwind n_4cafbe9bea0e.md');
});

test('a note with no ref is not filed at all, rather than filed as "undefined"', () => {
  assert.equal(fileNameFor({ title: 'x' }), null);
});

test('a slash in a title cannot escape the folder', () => {
  const n = { ...note, title: 'Q3/Q4 planning: a "big" one' };
  const name = fileNameFor(n);
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.includes('"'), name);
  assert.ok(name.includes('n_4cafbe9bea0e'));
});

test("THE ONE THAT MATTERS: a user's own words survive a re-sync", () => {
  const first = mergeIntoExisting('', managedBody(note, { summary: 'They want 40 seats.' }));
  // the user annotates, both above and below our block
  const annotated = first.replace(END, END + '\n\n## My take\n\nPush for annual billing.')
                         .replace(BEGIN, '#meeting #northwind\n\n' + BEGIN);
  const second = mergeIntoExisting(annotated, managedBody(note, { summary: 'They want 60 seats now.' }));

  assert.ok(second.includes('Push for annual billing.'), 'note below the block was eaten');
  assert.ok(second.includes('#meeting #northwind'), 'tags above the block were eaten');
  assert.ok(second.includes('60 seats now'), 'the refreshed summary did not land');
  assert.ok(!second.includes('40 seats'), 'the stale summary was left behind');
});

test('a file the user made at our path is appended to, never overwritten', () => {
  const mine = '# My own note\n\nSomething I wrote.\n';
  const out = mergeIntoExisting(mine, managedBody(note));
  assert.ok(out.includes('Something I wrote.'));
  assert.ok(out.includes(BEGIN));
});

test('the managed block is deterministic — same note, same bytes', () => {
  assert.equal(managedBody(note, { summary: 's' }), managedBody(note, { summary: 's' }));
});

test('action items are never pre-ticked, because Scriben has no completion state', () => {
  const body = managedBody(note, { actionItems: [{ text: 'Send the quote' }] });
  assert.ok(body.includes('- [ ] Send the quote'));
  assert.ok(!body.includes('- [x]'));
});

test('frontmatter escapes a quote in the title instead of breaking the YAML', () => {
  const fm = frontMatter({ ...note, title: 'The "big" one' }, 'abc123');
  assert.ok(fm.includes('\\"big\\"'), fm);
  assert.ok(fm.includes('scriben_ref: "n_4cafbe9bea0e"'));
});

test('userRegion returns what the user wrote and nothing of ours', () => {
  const file = frontMatter(note, 'h') + '\n' + managedBody(note, { summary: 'ours' })
    + '\n\nMy own thoughts.\n';
  const u = userRegion(file);
  assert.equal(u, 'My own thoughts.');
  assert.ok(!u.includes('ours'));
  assert.ok(!u.includes('scriben_ref'));
});

// ---------------------------------------------------------------------------
// The note a person actually opens the next morning.

const rich = {
  summary: 'Northwind will take 40 seats if billing moves to annual. Lena raised SSO as a blocker.',
  actionItems: [
    { text: 'Send the revised quote for 40 seats', owner: 'agam', due: '2026-09-10T00:00:00Z' },
    { text: 'Confirm SSO timeline with engineering' },
  ],
  mentions: [{ name: 'Daniel Okafor' }, { name: 'Lena Fischer' }],
  flagged: [{ text: 'Discount above 15% needs sign-off' }],
  memories: [{ text: 'Daniel Okafor owns the budget for the Northwind deal.' }],
};

test('a synced note is structured the way a meeting is read back', () => {
  const body = managedBody(note, rich);
  // Order matters: what happened, what I owe, what is unresolved, who was
  // named, what Scriben now knows.
  const order = ['## Summary', '## Action items', '## Needs a decision', '## People', '## What Scriben remembers']
    .map(h => body.indexOf(h));
  expect: for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1] && order[i - 1] !== -1, `sections out of order at ${i}`);
  }
});

test('the metadata callout puts the facts in reading view, not just properties', () => {
  const body = managedBody(note, rich);
  assert.match(body, /^> \[!info\] 2026-09-06 · Pricing review · Daniel Okafor, Lena Fischer$/m);
});

test('an action item carries its owner and due date without inventing either', () => {
  const body = managedBody(note, rich);
  assert.match(body, /- \[ \] Send the revised quote for 40 seats {2}@agam 📅 2026-09-10/);
  // The second item has neither, and must not sprout an empty @ or 📅.
  assert.match(body, /- \[ \] Confirm SSO timeline with engineering$/m);
});

test('people become wikilinks, which is the thing a vault can do that a transcript cannot', () => {
  const body = managedBody(note, rich);
  assert.ok(body.includes('- [[Daniel Okafor]]'));
  assert.ok(body.includes('- [[Lena Fischer]]'));
});

test('a name containing wikilink syntax cannot break out of the link', () => {
  const body = managedBody(note, { mentions: [{ name: 'Ana [[Ruiz]] | x' }] });
  assert.ok(body.includes('- [[Ana Ruiz x]]'), body.slice(body.indexOf('## People')));
});

test('empty sections are omitted, not printed as bare headings', () => {
  const body = managedBody(note, { summary: 'Just a summary.' });
  assert.ok(body.includes('## Summary'));
  for (const h of ['## Action items', '## Needs a decision', '## People', '## What Scriben remembers']) {
    assert.ok(!body.includes(h), `${h} rendered with nothing under it`);
  }
});

test('frontmatter dates are a real Obsidian date property, not a quoted string', () => {
  const fm = frontMatter(note, 'h');
  // Quoted or full-ISO and it is just text: it drops out of every dated query.
  assert.match(fm, /^date: 2026-09-06$/m);
  assert.match(fm, /^tags:\n  - scriben\n  - meeting$/m);
});

test('a note with no usable date omits the property rather than writing garbage', () => {
  assert.ok(!frontMatter({ ...note, date: 'sometime' }, 'h').includes('date:'));
});
