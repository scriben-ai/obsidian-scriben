/**
 * What a sync will do, decided before anything touches the disk.
 *
 * Kept separate from the Obsidian API on purpose: every rule that can put a
 * file in the wrong place, or send the wrong thing to a server, is decided in
 * here, where it can be tested without an app running.
 */
import { fileNameFor } from './markdown.mjs';

/**
 * A content fingerprint, in plain JS on purpose.
 *
 * `node:crypto` and `Buffer` do not exist on Obsidian mobile, and this plugin
 * declares isDesktopOnly:false — importing them builds a plugin that works on a
 * laptop and throws on a phone, which is the kind of break that only shows up
 * in a user's hands. WebCrypto would be portable but is async, and a change
 * check that has to be awaited turns every planning function into a promise.
 *
 * FNV-1a. Not a security primitive and never used as one: this only answers
 * "are these bytes the same as last time".
 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // A second pass over the length keeps two different-length strings that
  // collide in the first from sharing a fingerprint.
  let g = 0x811c9dc5 ^ s.length;
  for (let i = s.length - 1; i >= 0; i--) {
    g ^= s.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return (h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0'));
}

/** UTF-8 byte length without Buffer, which mobile does not have. */
const utf8Bytes = (s) => new TextEncoder().encode(String(s)).length;

/** Identity of a note's CONTENT, so an unchanged note is not rewritten. */
export function noteHash(note, extras = {}) {
  return fingerprint(JSON.stringify([
    note?.ref ?? '', note?.title ?? '', note?.date ?? '', note?.type ?? '',
    note?.participants ?? [], extras.summary ?? null,
    (extras.actionItems ?? []).map((a) => a?.text ?? a),
  ]));
}

/**
 * Which notes need writing.
 *
 * `existing` maps ref -> { path, hash }, read from the vault's own frontmatter
 * rather than from a state file the plugin keeps. A sidecar state file and a
 * vault drift apart the moment the user syncs the vault across two machines,
 * and then the plugin rewrites files it already wrote, or skips ones it never
 * did. The vault IS the state.
 */
/**
 * @param {any[]} notes
 * @param {Map<string,{path:string,hash:string}>} [existing]
 * @param {Map<string,string>} [hashes]
 */
export function planPull(notes, existing = new Map(), hashes = new Map()) {
  const write = [];
  const skip = [];
  const seen = new Set();
  for (const note of notes ?? []) {
    const name = fileNameFor(note);
    if (!name || seen.has(note.ref)) continue;   // a ref-less row cannot be filed
    seen.add(note.ref);
    const prior = existing.get(note.ref);
    const hash = hashes.get(note.ref) ?? null;
    if (prior && hash && prior.hash === hash) { skip.push({ ref: note.ref, path: prior.path }); continue; }
    // A note that moved because its title changed keeps its OLD path: renaming
    // breaks every [[wikilink]] the user made to it, which is a worse outcome
    // than a filename that no longer matches the title.
    write.push({ ref: note.ref, path: prior?.path ?? name, note, renamed: false });
  }
  return { write, skip };
}

/**
 * Which vault files may be sent to Scriben.
 *
 * ALLOWLIST, NEVER THE WHOLE VAULT. The user names folders; anything outside
 * them is invisible to us. A vault holds journals, medical notes and passwords
 * alongside meeting notes, and "sync my notes" must never be read as consent
 * to upload all of it.
 */
/**
 * @param {{path: string, body: string}[]} files
 * @param {{ folders?: string[], maxBytes?: number, sent?: Map<string,string> }} [opts]
 */
export function planPush(files, { folders = [], maxBytes = 200_000, sent = new Map() } = {}) {
  const roots = folders.map((f) => String(f).replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const send = [];
  const skipped = [];
  for (const f of files ?? []) {
    const path = String(f?.path ?? '');
    if (!path.endsWith('.md')) { skipped.push({ path, why: 'not-markdown' }); continue; }
    const inScope = roots.some((r) => path === r || path.startsWith(r + '/'));
    if (!inScope) { skipped.push({ path, why: 'outside-shared-folders' }); continue; }
    const body = String(f?.body ?? '').trim();
    if (!body) { skipped.push({ path, why: 'empty' }); continue; }
    if (utf8Bytes(body) > maxBytes) { skipped.push({ path, why: 'too-large' }); continue; }
    const hash = fingerprint(body);
    if (sent.get(path) === hash) { skipped.push({ path, why: 'unchanged' }); continue; }
    send.push({ path, body, hash });
  }
  return { send, skipped };
}
