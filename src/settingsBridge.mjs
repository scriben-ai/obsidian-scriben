/**
 * The join between Obsidian's declarative settings API and our settings shape.
 *
 * Obsidian 1.13 renders a settings tab from getSettingDefinitions() and reads and
 * writes each control through a single string key. Two of ours do not survive that
 * trip untouched: shared folders are an array the user edits as lines of text, and
 * the sync interval is a number the dropdown hands back as a string.
 *
 * It lives here, and is tested, because the declarative path is the one path we
 * cannot run: on 1.13 display() is never called, so a mistake in this conversion
 * is not a cosmetic glitch — it is the settings tab, which is the only way anyone
 * connects the plugin.
 */

/** Keys that reach the user as something other than their stored type. */
export const FOLDERS_KEY = 'sharedFolders';
export const INTERVAL_KEY = 'autoSyncMinutes';

/**
 * What a control should show for `key`.
 * @param {Record<string, unknown>} settings
 * @param {string} key
 */
export function controlValue(settings, key) {
  if (key === FOLDERS_KEY) {
    const list = settings[FOLDERS_KEY];
    return Array.isArray(list) ? list.join('\n') : '';
  }
  // Dropdown options are keyed by string; a number would match no option and the
  // control would render with nothing selected.
  if (key === INTERVAL_KEY) return String(settings[INTERVAL_KEY] ?? 60);
  return settings[key];
}

/**
 * Apply what the user just changed. Returns what the caller must do about it,
 * rather than doing it — saving and restarting a timer are the plugin's job.
 * @param {Record<string, unknown>} settings
 * @param {string} key
 * @param {unknown} value
 * @returns {{ changed: boolean, restartTimer: boolean }}
 */
export function applyControlValue(settings, key, value) {
  switch (key) {
    case 'notesFolder':
      // An empty folder name would file notes at the vault root, scattering them
      // through everything else the user keeps.
      settings.notesFolder = String(value ?? '').trim() || 'Scriben';
      return { changed: true, restartTimer: false };
    case 'syncOnStartup':
      settings.syncOnStartup = Boolean(value);
      return { changed: true, restartTimer: false };
    case 'autoSync':
      settings.autoSync = Boolean(value);
      return { changed: true, restartTimer: true };
    case INTERVAL_KEY:
      settings[INTERVAL_KEY] = Number(value) || 60;
      return { changed: true, restartTimer: true };
    case 'shareBack':
      settings.shareBack = Boolean(value);
      return { changed: true, restartTimer: false };
    case FOLDERS_KEY:
      settings[FOLDERS_KEY] = String(value ?? '')
        .split('\n').map((x) => x.trim()).filter(Boolean);
      return { changed: true, restartTimer: false };
    default:
      // An unknown key is not written blindly: this receives whatever the host
      // passes, and settings is the file we persist.
      return { changed: false, restartTimer: false };
  }
}
