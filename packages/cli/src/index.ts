#!/usr/bin/env node
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_STATE_FILE,
  normalizeNotionId,
  NotionClient,
  ShareParentType,
  SyncEngine,
} from '@obsidian-notion-sync/core';
import { Command } from 'commander';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { NodeHttpTransport } from './adapters/node-http-transport.js';
import { NodeVaultAdapter } from './adapters/node-vault-adapter.js';
import { loadCliConfig, saveCliConfig } from './config.js';

const program = new Command();

program
  .name('obsidian-notion')
  .description('Share Obsidian notes via Notion and incrementally back up or restore vaults.')
  .version('1.0.0');

function resolveNoteRelativePath(vaultDir: string, noteArg: string): string {
  const absVault = path.resolve(vaultDir);
  const absNote = path.isAbsolute(noteArg) ? noteArg : path.resolve(absVault, noteArg);
  const rel = path.relative(absVault, absNote).split(path.sep).join('/');
  if (rel.startsWith('..')) {
    throw new Error(`Note "${noteArg}" is outside the vault directory "${absVault}".`);
  }
  return rel;
}

program
  .command('init')
  .description('Interactively create .obsidian-notion.json inside an Obsidian vault')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .action(async (opts: { vault: string }) => {
    const rl = readline.createInterface({ input, output });
    try {
      const vaultPath = path.resolve(opts.vault);
      console.log(`Configuring obsidian-notion-sync for vault: ${vaultPath}\n`);

      const existing = await loadCliConfig(vaultPath);
      const token = (
        await rl.question(
          `Notion Integration Token${existing.notionToken ? ' [keep existing]' : ''}: `
        )
      ).trim() || existing.notionToken;

      const backupInput = (
        await rl.question(
          `Private Backup Root Page ID or URL${existing.backupRootPageId ? ` [${existing.backupRootPageId}]` : ''}: `
        )
      ).trim() || existing.backupRootPageId;

      const shareInput = (
        await rl.question(
          `Public Share Parent Page/Database ID or URL${existing.shareParentId ? ` [${existing.shareParentId}]` : ''}: `
        )
      ).trim() || existing.shareParentId;

      const shareTypeInput = (
        await rl.question(`Share Parent type (page/database) [${existing.shareParentType}]: `)
      ).trim().toLowerCase();
      const shareParentType: ShareParentType =
        shareTypeInput === 'database' ? 'database' : shareTypeInput === 'page' ? 'page' : existing.shareParentType;

      const savedPath = await saveCliConfig(vaultPath, {
        notionToken: token,
        backupRootPageId: normalizeNotionId(backupInput) ?? backupInput,
        shareParentId: normalizeNotionId(shareInput) ?? shareInput,
        shareParentType,
        writeFrontmatterOnShare: existing.writeFrontmatterOnShare,
        includeFrontmatterInBackup: existing.includeFrontmatterInBackup,
        archiveDeletedInBackup: existing.archiveDeletedInBackup,
        excludePatterns: existing.excludePatterns.length > 0 ? existing.excludePatterns : [...DEFAULT_EXCLUDE_PATTERNS],
        stateFilePath: existing.stateFilePath ?? DEFAULT_STATE_FILE,
      });

      console.log(`\nSaved configuration to ${savedPath}`);
    } finally {
      rl.close();
    }
  });

program
  .command('test')
  .description('Verify Notion API token connectivity')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .option('--token <token>', 'Override Notion integration token')
  .action(async (opts: { vault: string; token?: string }) => {
    const config = await loadCliConfig(opts.vault, { token: opts.token });
    if (!config.notionToken) {
      console.error('Error: No Notion token found. Run `obsidian-notion init` or set NOTION_TOKEN.');
      process.exit(1);
    }
    const client = new NotionClient({
      token: config.notionToken,
      transport: new NodeHttpTransport(),
    });
    const info = await client.testConnection();
    console.log(
      `Connected to Notion as "${info.botName}"${info.workspaceName ? ` (workspace: ${info.workspaceName})` : ''}.`
    );
  });

program
  .command('share <note>')
  .description('Share (or update) a single Obsidian note inside the public Notion Share Parent')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .option('-f, --force', 'Force re-upload even if content hash is unchanged', false)
  .option('--token <token>', 'Override Notion integration token')
  .option('--share-parent <id>', 'Override Notion Share Parent ID/URL')
  .action(
    async (
      note: string,
      opts: { vault: string; force: boolean; token?: string; shareParent?: string }
    ) => {
      const config = await loadCliConfig(opts.vault, {
        token: opts.token,
        shareParentId: opts.shareParent,
      });
      if (!config.notionToken) {
        console.error('Error: Missing Notion token. Run `obsidian-notion init` or set NOTION_TOKEN.');
        process.exit(1);
      }

      const relNote = resolveNoteRelativePath(opts.vault, note);
      const vault = new NodeVaultAdapter(opts.vault);
      const notion = new NotionClient({
        token: config.notionToken,
        transport: new NodeHttpTransport(),
      });
      const engine = new SyncEngine(vault, notion, config);

      const res = await engine.shareNote(relNote, { force: opts.force });
      const verb = res.created ? 'Created' : res.skipped ? 'Up to date' : 'Updated';
      console.log(`${verb}: ${res.notePath}`);
      console.log(`URL: ${res.url}`);
    }
  );

program
  .command('unshare <note>')
  .description('Archive a previously shared note in Notion and remove its share state')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .option('--token <token>', 'Override Notion integration token')
  .action(async (note: string, opts: { vault: string; token?: string }) => {
    const config = await loadCliConfig(opts.vault, { token: opts.token });
    if (!config.notionToken) {
      console.error('Error: Missing Notion token.');
      process.exit(1);
    }

    const relNote = resolveNoteRelativePath(opts.vault, note);
    const vault = new NodeVaultAdapter(opts.vault);
    const notion = new NotionClient({
      token: config.notionToken,
      transport: new NodeHttpTransport(),
    });
    const engine = new SyncEngine(vault, notion, config);

    const removed = await engine.unshareNote(relNote);
    if (removed) {
      console.log(`Unshared and archived "${relNote}" in Notion.`);
    } else {
      console.log(`"${relNote}" is not currently shared.`);
    }
  });

program
  .command('backup')
  .description('Incrementally back up the Obsidian vault (or a subfolder) to Notion')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .option('-f, --force', 'Re-upload all notes regardless of content hash', false)
  .option('--folder <subpath>', 'Only back up notes inside a specific vault subfolder')
  .option('--token <token>', 'Override Notion integration token')
  .option('--backup-root <id>', 'Override Notion Backup Root Page ID/URL')
  .action(
    async (opts: {
      vault: string;
      force: boolean;
      folder?: string;
      token?: string;
      backupRoot?: string;
    }) => {
      const config = await loadCliConfig(opts.vault, {
        token: opts.token,
        backupPageId: opts.backupRoot,
      });
      if (!config.notionToken) {
        console.error('Error: Missing Notion token. Run `obsidian-notion init` or set NOTION_TOKEN.');
        process.exit(1);
      }

      const vault = new NodeVaultAdapter(opts.vault);
      const notion = new NotionClient({
        token: config.notionToken,
        transport: new NodeHttpTransport(),
      });
      const engine = new SyncEngine(vault, notion, config);

      const res = await engine.backupVault({
        force: opts.force,
        folder: opts.folder,
        onProgress: (ev) => {
          const count = ev.total > 0 ? ` [${ev.current}/${ev.total}]` : '';
          console.log(`[${ev.phase}]${count} ${ev.message}`);
        },
      });

      console.log('\nBackup Summary:');
      console.log(`  Scanned:  ${res.totalScanned}`);
      console.log(`  Created:  ${res.created}`);
      console.log(`  Updated:  ${res.updated}`);
      console.log(`  Skipped:  ${res.skipped}`);
      console.log(`  Archived: ${res.archived}`);
      if (res.errors.length > 0) {
        console.error(`  Errors:   ${res.errors.length}`);
        for (const err of res.errors) {
          console.error(`    - ${err.path}: ${err.error}`);
        }
        process.exitCode = 1;
      }
    }
  );

program
  .command('restore')
  .description('Restore notes, folders, frontmatter, and attachments from Notion backup to a local directory')
  .requiredOption('-o, --out <dir>', 'Destination directory for restored vault files')
  .option('-v, --vault <dir>', 'Source vault directory (used to load config)', process.cwd())
  .option('--token <token>', 'Override Notion integration token')
  .option('--backup-root <id>', 'Override Notion Backup Root Page ID/URL')
  .action(
    async (opts: { out: string; vault: string; token?: string; backupRoot?: string }) => {
      const config = await loadCliConfig(opts.vault, {
        token: opts.token,
        backupPageId: opts.backupRoot,
      });
      if (!config.notionToken) {
        console.error('Error: Missing Notion token. Run `obsidian-notion init` or set NOTION_TOKEN.');
        process.exit(1);
      }

      const sourceVault = new NodeVaultAdapter(opts.vault);
      const targetVault = new NodeVaultAdapter(opts.out);
      const notion = new NotionClient({
        token: config.notionToken,
        transport: new NodeHttpTransport(),
      });
      const engine = new SyncEngine(sourceVault, notion, config);

      const res = await engine.restoreVault(targetVault, {
        onProgress: (ev) => console.log(`[${ev.phase}] ${ev.message}`),
      });

      console.log('\nRestore Summary:');
      console.log(`  Notes restored:       ${res.notesRestored}`);
      console.log(`  Attachments restored: ${res.attachmentsRestored}`);
      if (res.errors.length > 0) {
        console.error(`  Errors:               ${res.errors.length}`);
        for (const err of res.errors) {
          console.error(`    - ${err.title}: ${err.error}`);
        }
        process.exitCode = 1;
      }
    }
  );

program
  .command('status')
  .description('Show local vault backup & share status (offline, no Notion API calls)')
  .option('-v, --vault <dir>', 'Path to Obsidian vault', process.cwd())
  .action(async (opts: { vault: string }) => {
    const config = await loadCliConfig(opts.vault);
    const vault = new NodeVaultAdapter(opts.vault);
    const notion = new NotionClient({
      token: config.notionToken || 'unused',
      transport: new NodeHttpTransport(),
    });
    const engine = new SyncEngine(vault, notion, config);

    const status = await engine.getStatus();
    console.log(`Vault: ${path.resolve(opts.vault)}`);
    console.log(`  Total notes:          ${status.totalNotes}`);
    console.log(`  Backed up (clean):    ${status.backedUpUnchanged}`);
    console.log(`  Backed up (modified): ${status.backedUpModified}`);
    console.log(`  Not backed up yet:    ${status.notBackedUp}`);
    console.log(`  Deleted locally:      ${status.deletedLocally}`);
    console.log(`  Shared notes:         ${status.sharedNotes.length}`);
    for (const shared of status.sharedNotes) {
      console.log(`    - ${shared.path} -> ${shared.url}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
