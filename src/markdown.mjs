/**
 * Turning a Scriben note into a vault file, and back.
 *
 * Two rules drive every decision here, and both come from the same place: a
 * vault is the user's, not ours.
 *
 * 1. WE OWN A REGION, NOT A FILE. Everything between the managed markers is
 *    rewritten on every sync; everything outside is the user's and is carried
 *    through untouched. A plugin that rewrites whole files eats the annotation
 *    someone added under the summary, which is the entire reason they put the
 *    meeting in their vault.
 * 2. THE FILENAME IS STABLE OR IT IS A DUPLICATE. It is derived from the note's
 *    immutable ref, never from its title — a re-summarised meeting changes its
 *    title, and a title-derived name would file a second copy beside the first.
 */

export const BEGIN = '<!-- scriben:begin -->';
export const END = '<!-- scriben:end -->';

/** Characters no major filesystem will take, plus the ones Obsidian reserves for links. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/**
 * A filename a human can read, that still points at exactly one note.
 *
 * The ref is the identity and always survives; the title is decoration and is
 * truncated. 80 chars keeps the whole path under the 255-byte limit even when
 * the vault sits several folders deep on an encrypted volume.
 */
/** @param {import('./types').ScribenNote} note @returns {string|null} */
export function fileNameFor(note) {
  const ref = String(note?.ref ?? '').trim();
  if (!ref) return null;
  const date = (String(note?.date ?? '').match(/^\d{4}-\d{2}-\d{2}/) ?? [''])[0];
  const title = String(note?.title ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return [date, title, ref].filter(Boolean).join(' ') + '.md';
}

const yamlString = (v) => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const yamlList = (xs) => (xs?.length ? '\n' + xs.map((x) => `  - ${yamlString(x)}`).join('\n') : ' []');

/**
 * Frontmatter, which is also the sync's memory.
 *
 * `scriben_ref` is what a later sync matches on, and `scriben_hash` is what
 * lets it skip a file that has not changed — without it every sync rewrites
 * every note, and Obsidian's own file-watcher then reports the whole vault as
 * modified to whatever else the user syncs with.
 */
/** @param {import('./types').ScribenNote} note @param {string} hash @returns {string} */
export function frontMatter(note, hash) {
  const lines = [
    '---',
    `scriben_ref: ${yamlString(note.ref)}`,
    `scriben_hash: ${yamlString(hash)}`,
    `title: ${yamlString(note.title ?? '')}`,
  ];
  // Bare `yyyy-mm-dd` and no quotes: Obsidian parses that as a real date
  // property, which is what makes the note show up in a dated query. A quoted
  // ISO timestamp is just a string and silently drops out of every one.
  const day = String(note.date ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) lines.push(`date: ${day}`);
  if (note.type) lines.push(`type: ${yamlString(note.type)}`);
  lines.push(`participants:${yamlList(note.participants)}`);
  lines.push('tags:\n  - scriben\n  - meeting');
  lines.push('---');
  return lines.join('\n');
}

/**
 * The part of the file we own. Deterministic: same note in, same bytes out.
 *
 * Section order follows how a meeting note is actually read afterwards: what
 * happened, what I owe, who was named, what Scriben now knows. Empty sections
 * are omitted rather than printed as headings with nothing under them — a run
 * of empty headings makes a note look broken, and Obsidian's outline fills with
 * dead entries.
 */
/**
 * @param {import('./types').ScribenNote} note
 * @param {import('./types').NoteExtras} [extras]
 * @returns {string}
 */
export function managedBody(note, {
  summary = null, actionItems = [], mentions = [], memories = [], flagged = [],
} = {}) {
  const out = [BEGIN, '', `# ${note.title ?? 'Untitled meeting'}`, ''];

  // One metadata line as a callout, so the facts are visible in reading view
  // without opening the properties panel.
  const meta = [
    String(note.date ?? '').slice(0, 10),
    note.type || null,
    note.participants?.length ? note.participants.join(', ') : null,
  ].filter(Boolean);
  if (meta.length) out.push(`> [!info] ${meta.join(' · ')}`, '');

  if (summary) out.push('## Summary', '', String(summary).trim(), '');

  if (actionItems.length) {
    out.push('## Action items', '');
    // Unchecked, always: Scriben has no completion state to report, so a ticked
    // box would be a claim we cannot back. The box is the user's to tick, and it
    // survives a re-sync because ticking it does not change our text.
    for (const a of actionItems) {
      const text = String(a?.text ?? a).trim();
      if (!text) continue;
      const who = a?.owner || a?.assignee;
      const due = a?.due || a?.due_date;
      const tail = [who ? `@${who}` : null, due ? `📅 ${String(due).slice(0, 10)}` : null]
        .filter(Boolean).join(' ');
      out.push(`- [ ] ${text}${tail ? '  ' + tail : ''}`);
    }
    out.push('');
  }

  if (flagged.length) {
    out.push('## Needs a decision', '');
    for (const f of flagged) {
      const text = String(f?.text ?? f).trim();
      if (text) out.push(`- ${text}`);
    }
    out.push('');
  }

  if (mentions.length) {
    // Wikilinks, because this is the one thing a vault does that a transcript
    // cannot: the person becomes a node, and the meeting shows up in their
    // backlinks without anyone filing it there.
    out.push('## People', '');
    for (const m of mentions) {
      const name = String(m?.name ?? m?.person ?? m).trim();
      // Strip the link syntax, then collapse what it left behind — removing
      // `[[` and `]]` from a name leaves a double space otherwise.
      if (name) out.push(`- [[${name.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim()}]]`);
    }
    out.push('');
  }

  if (memories.length) {
    out.push('## What Scriben remembers', '');
    for (const mem of memories) {
      const text = String(mem?.text ?? mem).trim();
      if (text) out.push(`- ${text}`);
    }
    out.push('');
  }

  out.push(END);
  return out.join('\n');
}

/**
 * Merge our region into whatever is already on disk.
 *
 * A file with no markers is one the user made themselves at this path; we
 * append rather than overwrite, because the alternative is deleting a note
 * somebody wrote.
 */
/** @param {string} existing @param {string} managed @returns {string} */
export function mergeIntoExisting(existing, managed) {
  if (!existing) return managed + '\n';
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);
  if (start === -1 || stop === -1 || stop < start) {
    return existing.replace(/\s*$/, '') + '\n\n' + managed + '\n';
  }
  return existing.slice(0, start) + managed + existing.slice(stop + END.length);
}

/** Everything OUTSIDE our markers — what the user wrote, for the read direction. */
/** @param {string} content @returns {string} */
export function userRegion(content) {
  const s = String(content ?? '');
  const start = s.indexOf(BEGIN);
  const stop = s.indexOf(END);
  if (start === -1 || stop === -1 || stop < start) return s.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return (s.slice(0, start) + s.slice(stop + END.length))
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
}
