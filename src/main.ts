import {
  App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl,
} from 'obsidian';
import { ScribenApi, unwrap, DEFAULT_HOST } from './api.mjs';
import { frontMatter, managedBody, mergeIntoExisting, userRegion } from './markdown.mjs';
import type { ScribenNote, NoteExtras, ActionItem, Mention, MemoryFact } from './types';
import { planPull, planPush, noteHash } from './plan.mjs';

type Detail = Required<Pick<NoteExtras, 'summary' | 'actionItems' | 'mentions' | 'flagged' | 'memories'>>;

interface Settings {
  host: string;
  token: string;
  account: string;
  notesFolder: string;
  sharedFolders: string[];
  syncOnStartup: boolean;
  shareBack: boolean;
  sentHashes: Record<string, string>;
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
  shareBack: false,
  sentHashes: {},
};

export default class ScribenPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private syncing = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ScribenSettingTab(this.app, this));

    this.addRibbonIcon('microphone', 'Sync Scriben meetings', () => this.pull());
    this.addCommand({ id: 'sync', name: 'Sync meetings', callback: () => this.pull() });
    this.addCommand({ id: 'share', name: 'Share chosen notes', callback: () => this.push() });

    // Startup sync is deferred to onLayoutReady: on a large vault the metadata
    // cache is still building at onload, and reading frontmatter before it is
    // ready reports every note as new and refiles the lot.
    if (this.settings.syncOnStartup && this.settings.token) {
      this.app.workspace.onLayoutReady(() => { void this.pull(true); });
    }
  }

  api() {
    return new ScribenApi({ http: requestUrl, host: this.settings.host, token: this.settings.token });
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  /** ref -> { path, hash }, read from the vault itself rather than a sidecar. */
  private indexVault(): Map<string, { path: string; hash: string }> {
    const out = new Map<string, { path: string; hash: string }>();
    // Frontmatter only, and only from the metadata cache Obsidian already keeps
    // — no file is opened to build this. A file that carries no scriben_ref is
    // read no further than the key check.
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        { scriben_ref?: string; scriben_hash?: string } | undefined;
      if (fm?.scriben_ref) out.set(String(fm.scriben_ref), { path: file.path, hash: String(fm.scriben_hash ?? '') });
    }
    return out;
  }

  // ------------------------------------------------------------ Scriben -> vault
  async pull(quiet = false) {
    if (!this.settings.token) { if (!quiet) new Notice('Connect Scriben first.'); return; }
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
      if (!quiet || wrote) new Notice(`Scriben: ${wrote} updated, ${skip.length} already current.`);
    } catch (e) {
      new Notice(`Scriben sync failed: ${(e as Error)?.message ?? 'unknown error'}`);
    } finally {
      this.syncing = false;
    }
  }

  // ------------------------------------------------------------ vault -> Scriben
  async push() {
    if (!this.settings.token) { new Notice('Connect Scriben first.'); return; }
    if (!this.settings.shareBack || !this.settings.sharedFolders.length) {
      new Notice('No folders are shared with Scriben. Choose them in settings.');
      return;
    }
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
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!inScope(file.path)) continue;
      files.push({ path: file.path, body: userRegion(await this.app.vault.cachedRead(file)) });
    }
    const sent = new Map(Object.entries(this.settings.sentHashes));
    const { send, skipped } = planPush(files, { folders: this.settings.sharedFolders, sent });
    if (!send.length) { new Notice(`Scriben: nothing new to share (${skipped.length} unchanged or out of scope).`); return; }

    const res = await this.api().pushVaultNotes(send.map((s) => ({ path: s.path, text: s.body })));
    if (res.status === 404) { new Notice('This Scriben account cannot receive vault notes yet.'); return; }
    if (res.status !== 200) { new Notice(`Scriben rejected the notes (${res.status}).`); return; }
    for (const s of send) this.settings.sentHashes[s.path] = s.hash;
    await this.saveSettings();
    new Notice(`Scriben: shared ${send.length} note${send.length === 1 ? '' : 's'}.`);
  }

  async disconnect() {
    this.settings.token = '';
    this.settings.account = '';
    this.settings.sentHashes = {};
    await this.saveSettings();
    new Notice('Scriben disconnected. Your notes stay in the vault.');
  }
}

/** The pairing code, and nothing else on screen while it matters. */
class PairModal extends Modal {
  constructor(app: App, private code: string, private url: string, private onDone: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    // setTitle rather than an h3: the modal owns its own heading slot, and a
    // hand-rolled heading is the same inconsistency the review flags in the
    // settings tab.
    this.setTitle('Connect Scriben');
    contentEl.createEl('p', { text: 'Approve this vault in your browser, then enter the code shown there:' });
    contentEl.createEl('div', { text: this.code, cls: 'scriben-pair-code' });
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

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // --- connection ---------------------------------------------------------
    const conn = new Setting(containerEl).setName('Connection');
    if (s.token) {
      conn.setDesc(s.account ? `Connected as ${s.account}` : 'Connected');
      conn.addButton((b) => b.setButtonText('Disconnect').setDestructive()
        .onClick(async () => { await this.plugin.disconnect(); this.display(); }));
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
    new Setting(containerEl).addButton((b) => b.setButtonText('Sync now').onClick(() => this.plugin.pull()));

    // --- notes out ----------------------------------------------------------
    new Setting(containerEl).setName('Your notes back to Scriben').setHeading();
    containerEl.createEl('p', {
      text: 'Scriben reads only the folders you name here, so it can answer with your own context. Everything else in this vault stays private.',
      cls: 'scriben-note',
    });

    new Setting(containerEl).setName('Share chosen folders')
      .addToggle((t) => t.setValue(s.shareBack)
        .onChange(async (v) => { s.shareBack = v; await this.plugin.saveSettings(); this.display(); }));

    if (s.shareBack) {
      new Setting(containerEl).setName('Folders')
        .setDesc('One per line. Empty means nothing is shared.')
        .addTextArea((t) => t.setPlaceholder('Meetings\nProjects/Client work')
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
        modal.close();
        new Notice('Scriben connected.');
        this.display();
        void this.plugin.pull(true);
        return;
      }
      if (claimed.status !== 428 && claimed.status !== 404 && claimed.status !== 202) break;
    }
    if (!stop) { modal.close(); new Notice('The code expired. Try connecting again.'); }
  }
}
