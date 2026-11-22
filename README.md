# obsidian-notion-sync

A hybrid TypeScript monorepo (**Obsidian Plugin + CLI** sharing one core engine) to:
- **Share individual Obsidian notes via Notion** in one click (creating/updating a page inside a publicly shared Notion parent and copying the shareable URL).
- **Incrementally back up an entire Obsidian vault to Notion** (mirroring your folder hierarchy as nested private Notion pages, uploading local images/PDFs directly via Notion's File Upload API, and resolving `[[wikilinks]]` between synced pages).
- **Restore a vault from Notion back to local Markdown** (reconstructing folders, notes, YAML frontmatter, and attachments).

---

## Architecture

- **`packages/core`** (`@obsidian-notion-sync/core`): Platform-agnostic Obsidian Markdown ↔ Notion Blocks converter, Notion REST + Direct File Upload client (`Notion-Version: 2026-03-11`), rate limiter, state store (`.obsidian-notion-state.json`), and sync/restore orchestrator.
- **`packages/plugin`** (`@obsidian-notion-sync/plugin`): Native Obsidian plugin (Desktop & Mobile) using Obsidian's `Vault` and `requestUrl`.
- **`packages/cli`** (`@obsidian-notion-sync/cli`): Node.js CLI (`obsidian-notion`) for terminal usage and scheduled headless backups (`launchd` / `cron`).

Both the Plugin and CLI share the exact same `<vault>/.obsidian-notion-state.json` state file, and the CLI automatically reads your Notion credentials from the plugin's `data.json` if present.

---

## 1. Notion Setup (One-Time)

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and create a new **Internal Integration** (grant Content Read, Update, Insert capabilities). Copy the integration secret (`ntn_...`).
2. In Notion, create **two** destinations:
   - **Obsidian Backup** (a normal **private** page) — your entire vault folder hierarchy will be backed up here.
   - **Shared Notes** (a page or database) — click **Share → Publish** once in Notion so it is public on the web. Any note you share inside it automatically inherits a public URL.
3. On **both** Notion pages, open the `•••` menu → **Connections** → add your Internal Integration.

---

## 2. Build From Source

```bash
npm install
npm test
npm run typecheck
npm run build
```

---

## 3. Install the Obsidian Plugin

Copy the built plugin files into your Obsidian vault:

```bash
VAULT="/path/to/your/obsidian-vault"
mkdir -p "$VAULT/.obsidian/plugins/obsidian-notion-sync"
cp packages/plugin/manifest.json packages/plugin/main.js packages/plugin/styles.css \
  "$VAULT/.obsidian/plugins/obsidian-notion-sync/"
```

Then in Obsidian:
1. Open **Settings → Community plugins** and enable **Obsidian Notion Sync**.
2. Open **Settings → Obsidian Notion Sync**, paste your Notion token, Backup Root Page URL/ID, and Share Parent URL/ID, and click **Test connection**.
3. Use `Cmd+P` (or right-click any note/folder):
   - **Share current note to Notion** (copies the public URL and optionally writes `notion_url` to frontmatter)
   - **Copy Notion share link for current note**
   - **Unshare current note from Notion**
   - **Backup entire vault to Notion** / **Backup current folder to Notion**
   - **Restore vault backup from Notion**

---

## 4. Using the CLI

Link the CLI globally (or run via `node packages/cli/dist/index.js`):

```bash
npm link --workspace=@obsidian-notion-sync/cli
```

Commands:

```bash
# Optional if you already configured the Obsidian plugin:
obsidian-notion init --vault "/path/to/vault"

# Verify Notion API connection
obsidian-notion test --vault "/path/to/vault"

# Check local sync status (offline)
obsidian-notion status --vault "/path/to/vault"

# Share (or update) a single note
obsidian-notion share "Projects/Spec.md" --vault "/path/to/vault"

# Unshare a note (archives it in Notion)
obsidian-notion unshare "Projects/Spec.md" --vault "/path/to/vault"

# Incremental full-vault backup (only uploads new or changed notes)
obsidian-notion backup --vault "/path/to/vault"

# Restore from Notion backup into a fresh local directory
obsidian-notion restore --vault "/path/to/vault" --out "/path/to/restored-vault"
```

### Automated Scheduled Backups on macOS (`launchd`)

Save a plist at `~/Library/LaunchAgents/com.obsidian.notion-backup.plist` to run incremental backups every hour even when Obsidian is closed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.obsidian.notion-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/hamidrezaashkiyan/repos/obsidian-notion-sync/packages/cli/dist/index.js</string>
    <string>backup</string>
    <string>--vault</string>
    <string>/path/to/your/obsidian-vault</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>/tmp/obsidian-notion-backup.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/obsidian-notion-backup.err.log</string>
</dict>
</plist>
```

Load it with:
```bash
launchctl load ~/Library/LaunchAgents/com.obsidian.notion-backup.plist
```
