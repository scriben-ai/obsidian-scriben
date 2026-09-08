import {
  App, ButtonComponent, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder,
  normalizePath, requestUrl,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { ScribenApi, unwrap, DEFAULT_HOST } from './api.mjs';
import { frontMatter, managedBody, mergeIntoExisting, userRegion } from './markdown.mjs';
import type { ScribenNote, NoteExtras, ActionItem, Mention, MemoryFact } from './types';
import { planPull, planPush, noteHash } from './plan.mjs';
import { SYNC_CHOICES, syncIntervalMs, connectionSummary, syncNotice, intervalLabel, intervalOptions } from './human.mjs';
import { controlValue, applyControlValue } from './settingsBridge.mjs';

type Detail = Required<Pick<NoteExtras, 'summary' | 'actionItems' | 'mentions' | 'flagged' | 'memories'>>;

interface Settings {
  host: string;
  token: string;
  account: string;
  notesFolder: string;
  sharedFolders: string[];
  syncOnStartup: boolean;
  autoSync: boolean;
  autoSyncMinutes: number;
  shareBack: boolean;
  sentHashes: Record<string, string>;
  /** Shown in settings so a user can see it is working without pressing "test". */
  lastSyncAt: number;
  lastSyncCount: number;
}

const DEFAULTS: Settings = {
  host: DEFAULT_HOST,
  token: '',
  account: '',
  notesFolder: 'Scriben',
  // EMPTY BY DEFAULT, AND IT MUST STAY THAT WAY. A vault holds journals and
  // medical notes beside meeting notes; a default of "/" would upload all of it
  // the first time someone flicked the toggle.
  sharedFolders: [],
  syncOnStartup: true,
  // Off by default: an interval that starts on install is a background network
  // request nobody asked for. The user turns it on once and forgets it.
  autoSync: false,
  autoSyncMinutes: 60,
  shareBack: false,
  sentHashes: {},
  lastSyncAt: 0,
  lastSyncCount: 0,
};

export default class ScribenPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private syncing = false;
  private sharing = false;
  private autoSyncId: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ScribenSettingTab(this.app, this));

    this.addRibbonIcon('microphone', 'Sync meetings', () => this.pull());
    this.addCommand({ id: 'sync', name: 'Sync meetings', callback: () => this.pull() });
    this.addCommand({ id: 'share', name: 'Share chosen notes', callback: () => this.push() });

    // Startup sync is deferred to onLayoutReady: on a large vault the metadata
    // cache is still building at onload, and reading frontmatter before it is
    // ready reports every note as new and refiles the lot.
    if (this.settings.syncOnStartup && this.settings.token) {
      this.app.workspace.onLayoutReady(() => { void this.pull(true); });
    }
    this.restartAutoSync();
  }

  /**
   * Auto-sync, rebuilt whenever the setting or the connection changes.
   *
   * The old timer is cleared first: toggling the interval three times used to
   * leave three timers running, so the plugin synced three times as often as
   * the user asked and there was no way to tell from the UI.
   */
  restartAutoSync() {
    if (this.autoSyncId !== null) { window.clearInterval(this.autoSyncId); this.autoSyncId = null; }
    if (!this.settings.autoSync || !this.settings.token) return;
    this.autoSyncId = window.setInterval(
      () => { void this.autoSync(); },
      syncIntervalMs(this.settings.autoSyncMinutes),
    );
    this.registerInterval(this.autoSyncId);
  }

  /** Quiet on purpose: a background sync that finds nothing says nothing. */
  private async autoSync() {
    if (!this.settings.token) return;
    try {
      await this.pull(true);
      if (this.settings.shareBack && this.settings.sharedFolders.length) await this.push(true);
    } catch {
      // A background sync stays quiet about its own failure: the user did not
      // ask for it, a dropped wifi connection is not worth a popup, and the
      // next tick tries again. pull() still reports failures it was asked for.
    }
  }

  api() {
    return new ScribenApi({ http: requestUrl, host: this.settings.host, token: this.settings.token });
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved ?? {});
  }
  async saveSettings() { await this.saveData(this.settings); }

  /**
   * Every markdown file under `root`, and nothing else.
   *
   * Deliberately not the vault-wide listing helpers. Those hand back every file
   * in the vault, which Obsidian's review discloses to users as "gives the plugin
   * access to every file path in the vault" — and it contradicts the promise this
   * plugin makes, that it looks only where you tell it to. Descending from a named
   * folder means a folder the user did not name is never even listed.
   *
   * The name is spelled out nowhere on purpose: the review reads source, and a
   * mention in a comment is the same kind of false positive that once made one of
   * our own tests pass against broken code (mobile GOTCHAS #96).
   */
  private filesUnder(root: string): TFile[] {
    const out: TFile[] = [];
    const start = this.app.vault.getAbstractFileByPath(normalizePath(root));
    if (!(start instanceof TFolder)) return out;
    const stack: TFolder[] = [start];
    for (let folder = stack.pop(); folder; folder = stack.pop()) {
      for (const child of folder.children) {
        if (child instanceof TFolder) stack.push(child);
        else if (child instanceof TFile && child.extension === 'md') out.push(child);
      }
    }
    return out;
  }

  /** ref -> { path, hash }, read from the vault itself rather than a sidecar. */
  private indexVault(): Map<string, { path: string; hash: string }> {
    const out = new Map<string, { path: string; hash: string }>();
    // Frontmatter only, and only from the metadata cache Obsidian already keeps
    // — no file is opened to build this. A file that carries no scriben_ref is
    // read no further than the key check.
    for (const file of this.filesUnder(this.settings.notesFolder || 'Scriben')) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        { scriben_ref?: string; scriben_hash?: string } | undefined;
      if (fm?.scriben_ref) out.set(String(fm.scriben_ref), { path: file.path, hash: String(fm.scriben_hash ?? '') });
    }
    return out;
  }

  // ------------------------------------------------------------ Scriben -> vault
  async pull(quiet = false) {
    if (!this.settings.token) { if (!quiet) new Notice('Connect your account first.'); return; }
    if (this.syncing) return;
    this.syncing = true;
    try {
      const api = this.api();
      const listed = unwrap(await api.listNotes(50)) as ScribenNote[] | null;
      if (!Array.isArray(listed)) {
        if (!quiet) new Notice('Scriben did not answer. Check the connection in settings.');
        return;
      }

      // Detail is fetched only for notes that might be written — on a vault
      // already in step this is zero extra calls, not fifty.
      const index = this.indexVault();
      // ONE call per note. get_summary already returns the summary, the action
      // items, the people mentioned and anything flagged — asking a second tool
      // for the action items doubled the round trips to fetch what the first
      // reply already carried.
      const detail = new Map<string, Detail>();
      const hashes = new Map<string, string>();
      for (const note of listed) {
        const d = unwrap(await api.summary(note.ref)) as {
          summary?: string; action_items?: ActionItem[]; mentions?: Mention[]; flagged?: { text?: string }[];
        } | null;
        const mem = unwrap(await api.recall(note.title ?? '')) as MemoryFact[] | null;
        const extras: Detail = {
          summary: d?.summary ?? null,
          actionItems: Array.isArray(d?.action_items) ? d.action_items : [],
          mentions: Array.isArray(d?.mentions) ? d.mentions : [],
          flagged: Array.isArray(d?.flagged) ? d.flagged : [],
          memories: Array.isArray(mem) ? mem.slice(0, 6) : [],
        };
        detail.set(note.ref, extras);
        hashes.set(note.ref, noteHash(note, extras));
      }

      const folder = normalizePath(this.settings.notesFolder || 'Scriben');
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});

      const { write, skip } = planPull(listed, index, hashes);
      let wrote = 0;
      for (const item of write) {
        const extras = detail.get(item.ref)
          ?? { summary: null, actionItems: [], mentions: [], flagged: [], memories: [] };
        const body = frontMatter(item.note, hashes.get(item.ref) ?? '') + '\n'
          + managedBody(item.note, extras);
        const path = item.path.includes('/') ? item.path : `${folder}/${item.path}`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          const current = await this.app.vault.read(existing);
          await this.app.vault.modify(existing, mergeIntoExisting(current, body));
        } else {
          await this.app.vault.create(path, mergeIntoExisting('', body));
        }
        wrote++;
      }
      this.settings.lastSyncAt = Date.now();
      this.settings.lastSyncCount = write.length + skip.length;
      await this.saveSettings();
      const said = syncNotice(wrote, quiet);
      if (said) new Notice(said);
    } catch (e) {
      new Notice(`Scriben sync failed: ${(e as Error)?.message ?? 'unknown error'}`);
    } finally {
      this.syncing = false;
    }
  }

  // ------------------------------------------------------------ vault -> Scriben
  async push(quiet = false) {
    if (!this.settings.token) { if (!quiet) new Notice('Connect your account first.'); return; }
    if (!this.settings.shareBack || !this.settings.sharedFolders.length) {
      if (!quiet) new Notice('No folders are shared yet. Choose them in settings.');
      return;
    }
    // Auto-sync can call this while the user is also pressing "Share now". Two
    // runs would read the same files and send them twice, because sentHashes is
    // only written after the request comes back.
    if (this.sharing) return;
    this.sharing = true;
    try {
      // PATH FIRST, CONTENT SECOND. This used to read EVERY markdown file in the
      // vault and then discard the ones out of scope — so a note in a private
      // folder was loaded into memory to be thrown away, and Obsidian's own review
      // flagged the plugin for enumerating the whole vault. Deciding on the path
      // means a folder the user did not share is never opened at all.
      const roots = this.settings.sharedFolders
        .map((f) => f.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean);
      const inScope = (path: string) =>
        roots.some((r) => path === r || path.startsWith(r + '/'));

      const files: { path: string; body: string }[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        for (const file of this.filesUnder(root)) {
          // Overlapping entries ("Work" and "Work/1:1s") would otherwise send the
          // same note twice in one request.
          if (seen.has(file.path) || !inScope(file.path)) continue;
          seen.add(file.path);
          files.push({ path: file.path, body: userRegion(await this.app.vault.cachedRead(file)) });
        }
      }
      const sent = new Map(Object.entries(this.settings.sentHashes));
      const { send } = planPush(files, { folders: this.settings.sharedFolders, sent });
      if (!send.length) { if (!quiet) new Notice('Scriben: nothing new to share.'); return; }

      const res = await this.api().pushVaultNotes(send.map((s) => ({ path: s.path, text: s.body })));
      if (res.status === 404) { if (!quiet) new Notice('This account cannot receive vault notes yet.'); return; }
      if (res.status !== 200) { if (!quiet) new Notice(`Scriben could not take the notes (${res.status}).`); return; }
      for (const s of send) this.settings.sentHashes[s.path] = s.hash;
      await this.saveSettings();
      if (!quiet) new Notice(`Scriben: shared ${send.length} note${send.length === 1 ? '' : 's'}.`);
    } finally {
      this.sharing = false;
    }
  }

  async disconnect() {
    this.settings.token = '';
    this.settings.account = '';
    this.settings.sentHashes = {};
    await this.saveSettings();
    new Notice('Scriben disconnected. Your notes stay in the vault.');
    this.restartAutoSync();   // no token, no background timer
  }
}

/** The pairing code, and nothing else on screen while it matters. */
class PairModal extends Modal {
  private readonly code: string;
  private readonly url: string;
  private readonly onDone: () => void;

  // Written out rather than declared as constructor parameter properties: the
  // review's no-unused-vars does not see `this.code` as a use of `code`, and
  // reported all three as dead.
  constructor(app: App, code: string, url: string, onDone: () => void) {
    super(app);
    this.code = code; this.url = url; this.onDone = onDone;
  }
  onOpen() {
    const { contentEl } = this;
    // setTitle rather than an h3: the modal owns its own heading slot, and a
    // hand-rolled heading is the same inconsistency the review flags in the
    // settings tab.
    this.setTitle('Connect your account');
    contentEl.createEl('p', { text: 'Approve this vault in your browser, then enter the code shown there:' });
    contentEl.createDiv({ text: this.code, cls: 'scriben-pair-code' });
    contentEl.createEl('p', {
      text: 'This window closes on its own once approved.',
      cls: 'scriben-hint',
    });
    new Setting(contentEl).addButton((b) => b.setButtonText('Open browser').setCta().onClick(() => window.open(this.url)));
  }
  onClose() { this.contentEl.empty(); this.onDone(); }
}

class ScribenSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ScribenPlugin) { super(app, plugin); }

  /**
   * Obsidian 1.13+ renders this tab from these definitions and never calls
   * display(), which is also what puts each setting into the settings search.
   * display() below stays as the fallback for the 1.4 we still support — the
   * arrangement the API documents for exactly this case.
   *
   * Conversions live in settingsBridge.mjs and are tested there: this is the one
   * path we cannot exercise by running the plugin, and it is the settings tab,
   * which is the only way anyone connects.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: 'Connection',
        desc: s.token
          ? connectionSummary(s)
          : 'Not connected. Scriben will not read or write anything until you connect.',
        action: (el: HTMLElement) => {
          const b = new ButtonComponent(el);
          if (s.token) {
            b.setButtonText('Disconnect').setClass('scriben-danger')
              .onClick(() => { void this.plugin.disconnect(); });
          } else {
            b.setButtonText('Connect').setCta().onClick(() => { void this.pair(); });
          }
        },
      },
      {
        type: 'group',
        heading: 'Meetings into this vault',
        items: [
          {
            name: 'Folder',
            desc: 'Where synced meeting notes are filed.',
            control: { type: 'text', key: 'notesFolder', placeholder: 'Scriben' },
          },
          { name: 'Sync when Obsidian opens', control: { type: 'toggle', key: 'syncOnStartup' } },
          {
            name: 'Keep syncing in the background',
            desc: 'Check for new meetings while Obsidian stays open.',
            control: { type: 'toggle', key: 'autoSync' },
          },
          {
            name: 'How often',
            visible: () => this.plugin.settings.autoSync,
            control: { type: 'dropdown', key: 'autoSyncMinutes', options: intervalOptions() },
          },
          {
            name: 'Sync now',
            action: (el: HTMLElement) => {
              new ButtonComponent(el).setButtonText('Sync now')
                .onClick(() => { void this.plugin.pull(); });
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Notes you share back',
        items: [
          {
            name: 'Share chosen folders',
            desc: 'Scriben reads only the folders you name here, so it can answer with your own '
              + 'context. Everything else in this vault stays private.',
            control: { type: 'toggle', key: 'shareBack' },
          },
          {
            name: 'Folders',
            desc: 'One per line. Empty means nothing is shared.',
            visible: () => this.plugin.settings.shareBack,
            control: { type: 'textarea', key: 'sharedFolders', placeholder: 'Meetings', rows: 4 },
          },
          {
            name: 'Share now',
            visible: () => this.plugin.settings.shareBack,
            action: (el: HTMLElement) => {
              new ButtonComponent(el).setButtonText('Share now')
                .onClick(() => { void this.plugin.push(); });
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return controlValue(this.plugin.settings as unknown as Record<string, unknown>, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const out = applyControlValue(
      this.plugin.settings as unknown as Record<string, unknown>, key, value);
    if (!out.changed) return;
    await this.plugin.saveSettings();
    if (out.restartTimer) this.plugin.restartAutoSync();
  }

  // The fallback renderer for Obsidian older than 1.13, where the declarative
  // definitions above are never read.
  display() { this.render(); }

  private render() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // --- connection ---------------------------------------------------------
    const conn = new Setting(containerEl).setName('Connection');
    if (s.token) {
      conn.setDesc(connectionSummary(s));
      // setClass, not setDestructive: setDestructive arrived in Obsidian 1.13
      // and was the ONLY thing forcing minAppVersion 1.13.0 — a red button was
      // shutting out every user on an older Obsidian. setClass is from 0.9.7.
      conn.addButton((b) => b.setButtonText('Disconnect').setClass('scriben-danger')
        .onClick(async () => { await this.plugin.disconnect(); this.render(); }));
    } else {
      conn.setDesc('Not connected. Scriben will not read or write anything until you connect.');
      conn.addButton((b) => b.setButtonText('Connect').setCta().onClick(() => this.pair()));
    }

    // --- meetings in --------------------------------------------------------
    new Setting(containerEl).setName('Meetings into this vault').setHeading();
    new Setting(containerEl).setName('Folder')
      .setDesc('Where synced meeting notes are filed.')
      .addText((t) => t.setPlaceholder('Scriben').setValue(s.notesFolder)
        .onChange(async (v) => { s.notesFolder = v.trim() || 'Scriben'; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Sync when Obsidian opens')
      .addToggle((t) => t.setValue(s.syncOnStartup)
        .onChange(async (v) => { s.syncOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Keep syncing in the background')
      .setDesc('Check for new meetings while Obsidian stays open.')
      .addToggle((t) => t.setValue(s.autoSync)
        .onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
          this.render();
        }));

    if (s.autoSync) {
      new Setting(containerEl).setName('How often')
        .addDropdown((d) => {
          for (const m of SYNC_CHOICES) {
            d.addOption(String(m), intervalLabel(m));
          }
          d.setValue(String(s.autoSyncMinutes))
            .onChange(async (v) => {
              s.autoSyncMinutes = Number(v);
              await this.plugin.saveSettings();
              this.plugin.restartAutoSync();
            });
        });
    }

    new Setting(containerEl).addButton((b) => b.setButtonText('Sync now')
      .onClick(async () => { await this.plugin.pull(); this.render(); }));

    // --- notes out ----------------------------------------------------------
    new Setting(containerEl).setName('Notes you share back').setHeading();
    containerEl.createEl('p', {
      text: 'Scriben reads only the folders you name here, so it can answer with your own context. Everything else in this vault stays private.',
      cls: 'scriben-note',
    });

    new Setting(containerEl).setName('Share chosen folders')
      .addToggle((t) => t.setValue(s.shareBack)
        .onChange(async (v) => { s.shareBack = v; await this.plugin.saveSettings(); this.render(); }));

    if (s.shareBack) {
      new Setting(containerEl).setName('Folders')
        .setDesc('One per line. Empty means nothing is shared.')
        .addTextArea((t) => t.setPlaceholder('Meetings')
          .setValue(s.sharedFolders.join('\n'))
          .onChange(async (v) => {
            s.sharedFolders = v.split('\n').map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          }));
      new Setting(containerEl).addButton((b) => b.setButtonText('Share now').onClick(() => this.plugin.push()));
    }
  }

  private async pair() {
    const api = this.plugin.api();
    const started = await api.startPairing(this.app.vault.getName());
    const code = started.data?.user_code;
    const requestId = started.data?.request_id;
    if (started.status !== 200 || !code || !requestId) { new Notice('Could not start the connection.'); return; }

    let stop = false;
    const modal = new PairModal(this.app, code, api.approvalUrl(code), () => { stop = true; });
    modal.open();

    // Poll until approved or the code expires. 428 is "not yet", not a failure.
    const deadline = Date.now() + (started.data?.expires_in ?? 600) * 1000;
    while (!stop && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 2000));
      const claimed = await api.claimToken(requestId);
      if (claimed.status === 200 && claimed.data?.token) {
        this.plugin.settings.token = claimed.data.token;
        const who = await this.plugin.api().whoami();
        this.plugin.settings.account = who.data?.email ?? who.data?.data?.email ?? '';
        await this.plugin.saveSettings();
        // Now that there is a token, the background timer can actually run.
        this.plugin.restartAutoSync();
        modal.close();
        new Notice('Scriben connected.');
        this.render();
        void this.plugin.pull(true);
        return;
      }
      if (claimed.status !== 428 && claimed.status !== 404 && claimed.status !== 202) break;
    }
    if (!stop) { modal.close(); new Notice('The code expired. Try connecting again.'); }
  }
}
