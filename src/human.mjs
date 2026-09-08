/**
 * The bits of the UI a person actually reads.
 *
 * Kept out of main.ts so they can be tested: "synced 5 minutes ago" being wrong
 * is the kind of thing nobody notices until a user says the plugin looks broken
 * when it is working perfectly.
 */

/** Sync intervals we offer, in minutes. */
export const SYNC_CHOICES = [15, 30, 60, 180, 360];

/**
 * Minutes -> milliseconds, clamped. A saved settings file can hold anything —
 * a 0 here would spin a request loop against the server, and a NaN would make
 * setInterval fire continuously.
 * @param {unknown} minutes
 */
export function syncIntervalMs(minutes) {
  const n = Number(minutes);
  const safe = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 15), 1440) : 60;
  return safe * 60 * 1000;
}

/**
 * "just now" / "5 minutes ago" / "yesterday". Whole units only: "1.4 hours ago"
 * reads like a machine wrote it.
 * @param {number} [then] epoch ms, 0 or missing meaning never
 * @param {number} [now]
 */
export function sinceLabel(then, now = Date.now()) {
  if (!then || !Number.isFinite(then)) return 'never';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * What the settings pane says under "Connection". One line, so a user can tell
 * at a glance whether it is working without pressing a "test" button.
 * @param {{account?: string, lastSyncAt?: number, lastSyncCount?: number}} s
 * @param {number} [now]
 */
export function connectionSummary(s, now = Date.now()) {
  const who = s.account ? `Connected as ${s.account}` : 'Connected';
  if (!s.lastSyncAt) return `${who}. No meetings synced yet.`;
  const n = Number(s.lastSyncCount) || 0;
  const notes = `${n} meeting note${n === 1 ? '' : 's'} in this vault`;
  return `${who} · ${notes} · last synced ${sinceLabel(s.lastSyncAt, now)}`;
}

/**
 * What a finished sync says. Silent when nothing changed and nobody asked.
 * @param {number} wrote
 * @param {boolean} quiet
 */
export function syncNotice(wrote, quiet) {
  if (wrote > 0) return `Scriben: ${wrote} new meeting note${wrote === 1 ? '' : 's'}.`;
  return quiet ? null : 'Scriben: your meetings are up to date.';
}

/** Label for one interval. Shared, so the two settings paths cannot word it differently. */
export function intervalLabel(m) {
  if (m < 60) return `Every ${m} minutes`;
  if (m === 60) return 'Every hour';
  return `Every ${m / 60} hours`;
}

/** The dropdown's options, keyed by string because that is what the control reads. */
export function intervalOptions() {
  return Object.fromEntries(SYNC_CHOICES.map((m) => [String(m), intervalLabel(m)]));
}
