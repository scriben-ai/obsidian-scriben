# Scriben for Obsidian

Your meetings land in your vault as markdown. The notes you choose to share go
back, so Scriben can answer using your own context.

Scriben records meetings with a pen or a phone and writes the transcript,
summary and action items. This plugin puts that in the vault you already keep,
and — only for folders you name — lets Scriben read what you have written.

## What it does

**Meetings into your vault.** Each recording becomes one markdown note with
frontmatter, a summary and unchecked action items, filed in a folder you pick.
Sync runs when Obsidian opens, or on demand.

**Your notes back to Scriben.** Off by default. When you turn it on you name the
folders, and only those folders are ever read. Everything else in the vault
stays where it is.

## Your writing is never overwritten

The plugin owns the region between two markers and nothing else:

```markdown
---
scriben_ref: "n_4cafbe9bea0e"
---
#meeting #northwind          ← yours, kept

<!-- scriben:begin -->
# Pricing review with Northwind
## Summary
They want 40 seats.
<!-- scriben:end -->

## My take                   ← yours, kept
Push for annual billing.
```

Re-syncing refreshes only what is between the markers. Anything you add above or
below it is carried through untouched, and a file you wrote yourself at that
path is appended to rather than replaced.

Filenames are derived from the note's permanent reference, not its title, so a
re-summarised meeting updates in place instead of filing a second copy — and
your `[[wikilinks]]` keep resolving.

## What is read, and what is not

- Nothing is shared until you turn on **Share chosen folders** *and* name at
  least one folder. The default is empty, and empty means nothing is sent.
- Only `.md` files inside those folders are read. Subfolders count; a folder
  whose name merely *starts with* a shared one does not.
- The content Scriben receives is what **you** wrote — the plugin strips its own
  managed region and the frontmatter before sending, so it never sends your
  meeting notes back to the service they came from.
- Unchanged files are not re-sent.

## Install

**From Obsidian** — Settings → Community plugins → Browse → "Scriben".

**Manually** — download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/scriben-ai/obsidian-scriben/releases/latest)
into `<vault>/.obsidian/plugins/scriben/`, then enable it in Community plugins.

## Connect

1. Settings → Scriben → **Connect**
2. A code appears. Approve the vault in the browser and enter that code.
3. That is it — the first sync starts on its own.

The code binds the approval to the vault that asked for it, so a link someone
sends you cannot connect a vault you do not control.

**Disconnect** removes the token and forgets what was shared. Your notes stay in
the vault; nothing is deleted.

## Settings

| | |
|---|---|
| **Folder** | where meeting notes are filed (default `Scriben`) |
| **Sync when Obsidian opens** | on |
| **Share chosen folders** | off |
| **Folders** | one per line; empty shares nothing |

## Requirements

A Scriben account. Desktop and mobile both work.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # the rules that protect your vault
npm run build   # main.js
```

The logic that decides what is written and what may be sent lives in
`src/markdown.mjs` and `src/plan.mjs`, apart from the Obsidian API, so it can be
tested without an app running. If you change either, the tests in `test/` are
the ones to read first.

## Privacy

No telemetry. No analytics. The plugin talks to `app.scriben.ai` and nothing
else, and only when you have connected it.

## License

MIT
