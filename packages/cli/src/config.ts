import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_STATE_FILE,
  normalizeNotionId,
  ShareParentType,
  SyncConfig,
} from '@obsidian-notion-sync/core';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CliConfigOverrides {
  token?: string;
  backupPageId?: string;
  shareParentId?: string;
  shareParentType?: ShareParentType;
}

const CLI_CONFIG_FILENAME = '.obsidian-notion.json';
const PLUGIN_DATA_REL_PATH = '.obsidian/plugins/obsidian-notion-sync/data.json';

async function readJsonIfExists(filePath: string): Promise<Partial<SyncConfig> | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as Partial<SyncConfig>;
  } catch {
    return null;
  }
}

/**
 * Loads configuration in priority order:
 * 1. CLI flags
 * 2. Environment variables (NOTION_TOKEN, NOTION_BACKUP_PAGE_ID, NOTION_SHARE_PARENT_ID, NOTION_SHARE_PARENT_TYPE)
 * 3. `<vault>/.obsidian-notion.json`
 * 4. `<vault>/.obsidian/plugins/obsidian-notion-sync/data.json` (shared seamlessly with the Obsidian Plugin)
 */
export async function loadCliConfig(
  vaultPath: string,
  overrides: CliConfigOverrides = {}
): Promise<SyncConfig> {
  const resolvedVault = path.resolve(vaultPath);
  const pluginData = await readJsonIfExists(path.join(resolvedVault, PLUGIN_DATA_REL_PATH));
  const cliConfig = await readJsonIfExists(path.join(resolvedVault, CLI_CONFIG_FILENAME));

  const merged: Partial<SyncConfig> = {
    ...(pluginData ?? {}),
    ...(cliConfig ?? {}),
  };

  const notionToken =
    overrides.token ?? process.env.NOTION_TOKEN ?? merged.notionToken ?? '';
  const rawBackupId =
    overrides.backupPageId ?? process.env.NOTION_BACKUP_PAGE_ID ?? merged.backupRootPageId ?? '';
  const rawShareId =
    overrides.shareParentId ?? process.env.NOTION_SHARE_PARENT_ID ?? merged.shareParentId ?? '';
  const shareParentType =
    (overrides.shareParentType ??
      (process.env.NOTION_SHARE_PARENT_TYPE as ShareParentType | undefined) ??
      merged.shareParentType ??
      'page') as ShareParentType;

  return {
    notionToken: notionToken.trim(),
    backupRootPageId: normalizeNotionId(rawBackupId) ?? rawBackupId.trim(),
    shareParentId: normalizeNotionId(rawShareId) ?? rawShareId.trim(),
    shareParentType,
    writeFrontmatterOnShare: merged.writeFrontmatterOnShare ?? true,
    includeFrontmatterInBackup: merged.includeFrontmatterInBackup ?? true,
    archiveDeletedInBackup: merged.archiveDeletedInBackup ?? false,
    excludePatterns: merged.excludePatterns ?? [...DEFAULT_EXCLUDE_PATTERNS],
    stateFilePath: merged.stateFilePath ?? DEFAULT_STATE_FILE,
  };
}

export async function saveCliConfig(vaultPath: string, config: SyncConfig): Promise<string> {
  const filePath = path.join(path.resolve(vaultPath), CLI_CONFIG_FILENAME);
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return filePath;
}
