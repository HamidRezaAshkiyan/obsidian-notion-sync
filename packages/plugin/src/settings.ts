import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_STATE_FILE,
  normalizeNotionId,
  NotionClient,
  ShareParentType,
  SyncConfig,
} from '@obsidian-notion-sync/core';
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianNotionSyncPlugin from './main.js';
import { ObsidianHttpTransport } from './adapters/obsidian-http-transport.js';

export interface PluginSettings extends SyncConfig {
  /** Auto-backup interval in minutes while Obsidian is open (0 = disabled). */
  autoBackupIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  notionToken: '',
  backupRootPageId: '',
  shareParentId: '',
  shareParentType: 'page',
  writeFrontmatterOnShare: true,
  includeFrontmatterInBackup: true,
  archiveDeletedInBackup: false,
  excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  stateFilePath: DEFAULT_STATE_FILE,
  autoBackupIntervalMinutes: 0,
};

export class ObsidianNotionSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianNotionSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Notion Sync' });
    containerEl.createEl('p', {
      text: 'Connect a Notion Internal Integration to two Notion destinations: a private Backup Root Page and a publicly shared Share Parent.',
      cls: 'obsidian-notion-settings-note',
    });

    new Setting(containerEl)
      .setName('Notion integration token')
      .setDesc('Internal integration secret from notion.so/my-integrations (starts with ntn_ or secret_).')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('ntn_...')
          .setValue(this.plugin.settings.notionToken)
          .onChange(async (value) => {
            this.plugin.settings.notionToken = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText('Test connection').onClick(async () => {
          if (!this.plugin.settings.notionToken) {
            new Notice('Please enter your Notion integration token first.');
            return;
          }
          try {
            const client = new NotionClient({
              token: this.plugin.settings.notionToken,
              transport: new ObsidianHttpTransport(),
            });
            const info = await client.testConnection();
            new Notice(
              `Connected to Notion as "${info.botName}"${info.workspaceName ? ` (${info.workspaceName})` : ''}!`
            );
          } catch (err) {
            new Notice(`Notion connection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
      );

    containerEl.createEl('h3', { text: 'Sharing (Public)' });

    new Setting(containerEl)
      .setName('Share parent Page or Database ID / URL')
      .setDesc(
        'Publish this parent page/database to the web once in Notion. Shared notes created inside it automatically inherit a public URL.'
      )
      .addText((text) =>
        text
          .setPlaceholder('Paste Notion URL or page/database ID')
          .setValue(this.plugin.settings.shareParentId)
          .onChange(async (value) => {
            this.plugin.settings.shareParentId = normalizeNotionId(value) ?? value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Share parent type')
      .setDesc('Choose whether the Share Parent above is a Notion Page or a Notion Database.')
      .addDropdown((dd) =>
        dd
          .addOption('page', 'Page')
          .addOption('database', 'Database')
          .setValue(this.plugin.settings.shareParentType)
          .onChange(async (value) => {
            this.plugin.settings.shareParentType = value as ShareParentType;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Write notion_url to frontmatter when sharing')
      .setDesc('Stores notion_url and notion_shared_at in YAML frontmatter on shared notes only.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.writeFrontmatterOnShare)
          .onChange(async (value) => {
            this.plugin.settings.writeFrontmatterOnShare = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'Vault Backup (Private)' });

    new Setting(containerEl)
      .setName('Backup Root Page ID / URL')
      .setDesc('Private Notion page where your vault folder hierarchy will be backed up.')
      .addText((text) =>
        text
          .setPlaceholder('Paste Notion URL or page ID')
          .setValue(this.plugin.settings.backupRootPageId)
          .onChange(async (value) => {
            this.plugin.settings.backupRootPageId = normalizeNotionId(value) ?? value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Preserve YAML frontmatter in backups')
      .setDesc('Saves note frontmatter in a collapsed toggle block so Restore recovers it losslessly.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeFrontmatterInBackup)
          .onChange(async (value) => {
            this.plugin.settings.includeFrontmatterInBackup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Archive deleted notes in Notion backup')
      .setDesc('If enabled, notes deleted locally will be archived in your Notion backup on full backup.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.archiveDeletedInBackup)
          .onChange(async (value) => {
            this.plugin.settings.archiveDeletedInBackup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-backup interval (while Obsidian is open)')
      .setDesc('For headless scheduled backups when Obsidian is closed, use the companion CLI with launchd/cron.')
      .addDropdown((dd) =>
        dd
          .addOption('0', 'Disabled (manual only)')
          .addOption('30', 'Every 30 minutes')
          .addOption('60', 'Every hour')
          .addOption('240', 'Every 4 hours')
          .setValue(String(this.plugin.settings.autoBackupIntervalMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoBackupIntervalMinutes = Number(value);
            await this.plugin.saveSettings();
            this.plugin.configureAutoBackupTimer();
          })
      );

    new Setting(containerEl)
      .setName('Excluded path patterns')
      .setDesc('One glob pattern per line to exclude from vault backups.')
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area
          .setPlaceholder('.obsidian/**\n.trash/**\nPrivate/**')
          .setValue(this.plugin.settings.excludePatterns.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
      });
  }
}
