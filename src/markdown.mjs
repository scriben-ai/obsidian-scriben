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
export function frontMatter(note, hash) {
  const lines = [
    '---',
    `scriben_ref: ${yamlString(note.ref)}`,
    `scriben_hash: ${yamlString(hash)}`,
    `title: ${yamlString(note.title ?? '')}`,
  ];
  if (note.date) lines.push(`date: ${yamlString(note.date)}`);
  if (note.type) lines.push(`type: ${yamlString(note.type)}`);
  lines.push(`participants:${yamlList(note.participants)}`);
  lines.push('---');
  return lines.join('\n');
}

/** The part of the file we own. Deterministic: same note in, same bytes out. */
export function managedBody(note, { summary = null, actionItems = [] } = {}) {
  const out = [BEGIN, '', `# ${note.title ?? 'Untitled meeting'}`, ''];
  if (summary) out.push('## Summary', '', String(summary).trim(), '');
  if (actionItems.length) {
    out.push('## Action items', '');
    // Unchecked boxes, because Scriben has no completion state to report. A
    // pre-ticked item would be a claim we cannot back, and an unticked one the
    // user ticks is theirs — it lives inside the managed block, so say so.
    for (const a of actionItems) out.push(`- [ ] ${String(a.text ?? a).trim()}`);
    out.push('');
  }
  if (note.participants?.length) out.push(`**Participants:** ${note.participants.join(', ')}`, '');
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
export function userRegion(content) {
  const s = String(content ?? '');
  const start = s.indexOf(BEGIN);
  const stop = s.indexOf(END);
  if (start === -1 || stop === -1 || stop < start) return s.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return (s.slice(0, start) + s.slice(stop + END.length))
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
}
