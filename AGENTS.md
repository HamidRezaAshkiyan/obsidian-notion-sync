# AGENTS.md — obsidian-notion-sync

## Overview
Hybrid TypeScript npm-workspaces monorepo providing both an **Obsidian Plugin** and a **Node.js CLI** (`obsidian-notion`) backed by a single shared core engine. Supports one-click note sharing to a publicly published Notion parent, incremental full-vault backups (mirroring folder hierarchy, uploading local images/PDFs via Notion's Direct File Upload API, and resolving `[[wikilinks]]`), and full vault restores from Notion back to local Markdown.

## Tech Stack & Requirements
- **Monorepo:** npm workspaces (`packages/core`, `packages/plugin`, `packages/cli`), ESM (`"type": "module"`)
- **Language:** TypeScript (`^5.8.2`)
- **Markdown / YAML:** `unified`, `remark-parse`, `remark-gfm`, `remark-math`, `remark-frontmatter`, `yaml`
- **CLI:** `commander` (`^13.1.0`), Node.js `fs/promises`
- **Plugin:** Obsidian Plugin API (`minAppVersion: 1.4.0`, desktop & mobile), bundled via `esbuild` (`^0.25.0`)
- **Testing:** Vitest (`^3.0.9`)
- **Notion API:** REST + Direct File Upload API (`Notion-Version: 2026-03-11`)

## Repository Structure
```text
.
├── package.json                       # Workspace root scripts (build, typecheck, test, test:watch)
├── tsconfig.base.json                 # Shared TypeScript compiler options
├── vitest.config.ts                   # Root Vitest configuration
└── packages/
    ├── core/                          # @obsidian-notion-sync/core (platform-agnostic engine)
    │   ├── src/
    │   │   ├── index.ts               # Public core exports
    │   │   ├── types.ts               # SyncConfig, adapters, state & Notion types
    │   │   ├── markdown/
    │   │   │   ├── obsidian-to-notion.ts  # Obsidian Markdown -> Notion blocks converter
    │   │   │   └── notion-to-obsidian.ts  # Notion blocks -> Obsidian Markdown converter
    │   │   ├── notion/
    │   │   │   ├── client.ts          # Notion REST & Direct File Upload client
    │   │   │   ├── multipart.ts       # Multipart form-data builder for file uploads
    │   │   │   └── rate-limiter.ts    # Request throttling / retry handling
    │   │   ├── state/state-store.ts   # .obsidian-notion-state.json persistence
    │   │   ├── sync/sync-engine.ts    # Share, unshare, incremental backup, and restore orchestrator
    │   │   └── utils/notion-id.ts     # Notion URL / UUID normalization helpers
    │   └── test/                      # Vitest suites (obsidian-to-notion, notion-to-obsidian, sync-engine)
    ├── cli/                           # @obsidian-notion-sync/cli (bin: obsidian-notion)
    │   └── src/
    │       ├── index.ts               # Commander CLI entry (init, test, status, share, unshare, backup, restore)
    │       ├── config.ts              # Layered config loader (flags > env > .obsidian-notion.json > plugin data.json)
    │       └── adapters/              # Node filesystem & HTTP adapters for core
    └── plugin/                        # @obsidian-notion-sync/plugin (Obsidian community plugin)
        ├── manifest.json              # id: obsidian-notion-sync, isDesktopOnly: false
        ├── esbuild.config.mjs         # Bundles src/main.ts + core -> main.js
        ├── styles.css                 # Plugin UI styles
        └── src/
            ├── main.ts                # Obsidian Plugin entry: commands, context menus, sync actions
            ├── settings.ts            # Plugin settings tab & data.json persistence
            └── adapters/              # Obsidian Vault & requestUrl adapters for core
```

## Architecture & Key Flows
- **Adapter Pattern:** `packages/core` has zero Node/Obsidian runtime dependencies; it talks to filesystems and HTTP through injected adapters implemented separately in `packages/cli/src/adapters/` (Node `fs` + `fetch`) and `packages/plugin/src/adapters/` (Obsidian `Vault` + `requestUrl`).
- **Shared State:** Both plugin and CLI read/write `<vault>/.obsidian-notion-state.json` via `state-store.ts` to track content hashes, Notion page IDs, and shared URLs for incremental syncing.
- **Bidirectional Conversion:** `obsidian-to-notion.ts` parses Markdown (GFM, math, YAML frontmatter, wikilinks, attachments) via `unified`/`remark` into Notion blocks; `notion-to-obsidian.ts` reconstructs Markdown, frontmatter, and local attachments on restore.
- **CLI & Headless Backups:** `packages/cli/dist/index.js` can be linked globally (`obsidian-notion`) or scheduled via macOS `launchd` / `cron`.

## Development & Commands
```bash
npm install          # Install all workspace dependencies
npm test             # Run Vitest unit tests once (vitest run)
npm run test:watch   # Watch mode tests
npm run typecheck    # Typecheck core, plugin, and cli workspaces
npm run build        # Build core -> plugin (main.js) -> cli (dist/index.js)
```
Optional CLI link: `npm link --workspace=@obsidian-notion-sync/cli`.
Plugin install: copy `packages/plugin/manifest.json`, `packages/plugin/main.js`, and `packages/plugin/styles.css` to `<vault>/.obsidian/plugins/obsidian-notion-sync/`.

## Configuration & Environment
CLI config resolution priority (`packages/cli/src/config.ts`):
1. CLI flags (`--token`, `--backup-page-id`, etc.)
2. Environment variables:
   - `NOTION_TOKEN` — Notion Internal Integration secret (`ntn_...`)
   - `NOTION_BACKUP_PAGE_ID` — Private Notion page URL or ID for vault backups
   - `NOTION_SHARE_PARENT_ID` — Publicly published Notion page or database URL/ID for shared notes
   - `NOTION_SHARE_PARENT_TYPE` — `"page"` (default) or `"database"`
3. `<vault>/.obsidian-notion.json` (created by `obsidian-notion init`)
4. `<vault>/.obsidian/plugins/obsidian-notion-sync/data.json` (shared seamlessly with the Obsidian plugin)

Never commit Notion tokens or real vault `.obsidian-notion.json` / `data.json` files.

## Conventions & Gotchas
- **Build Order Matters:** `packages/plugin` and `packages/cli` depend on `@obsidian-notion-sync/core`. Always run root `npm run build` (or build `core` first) after editing `packages/core/src/`.
- **Platform Neutrality in Core:** Do not import `node:fs`, `node:path`, or `obsidian` in `packages/core/src/` — keep it runnable on both Obsidian mobile and Node.js.
- **Rate Limiting & Attachments:** Always route Notion API calls through `NotionClient` (`packages/core/src/notion/client.ts`) so `rate-limiter.ts` and `multipart.ts` handle throttling and Direct File Uploads consistently.
- **CLI Executable Bit:** `packages/cli` build runs `chmod +x dist/index.js` — preserve the shebang in `packages/cli/src/index.ts`.
