import { NotionClient, StateStore, SyncEngine } from '@obsidian-notion-sync/core';
import { App, Modal, Notice, Plugin, Setting, TFile, TFolder } from 'obsidian';
import { ObsidianHttpTransport } from './adapters/obsidian-http-transport.js';
import { ObsidianVaultAdapter } from './adapters/obsidian-vault-adapter.js';
import { DEFAULT_SETTINGS, ObsidianNotionSettingTab, PluginSettings } from './settings.js';

export default class ObsidianNotionSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private statusBarEl: HTMLElement | null = null;
  private autoBackupTimerId: number | null = null;
  private isSyncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('obsidian-notion-status');
    this.setStatusText('');

    this.addRibbonIcon('share-2', 'Share current note to Notion', async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice('Open a Markdown note to share it to Notion.');
        return;
      }
      await this.handleShareNote(file);
    });

    this.addCommand({
      id: 'share-current-note',
      name: 'Share current note to Notion',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.handleShareNote(file);
        return true;
      },
    });

    this.addCommand({
      id: 'copy-notion-share-link',
      name: 'Copy Notion share link for current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.handleCopyShareLink(file);
        return true;
      },
    });

    this.addCommand({
      id: 'unshare-current-note',
      name: 'Unshare current note from Notion',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.handleUnshareNote(file);
        return true;
      },
    });

    this.addCommand({
      id: 'backup-entire-vault',
      name: 'Backup entire vault to Notion',
      callback: () => void this.handleBackupVault(),
    });

    this.addCommand({
      id: 'backup-current-folder',
      name: 'Backup current folder to Notion',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const folder = file.parent?.path && file.parent.path !== '/' ? file.parent.path : undefined;
          void this.handleBackupVault(folder);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'restore-from-notion',
      name: 'Restore vault backup from Notion',
      callback: () => {
        new RestoreTargetModal(this.app, async (targetFolder) => {
          await this.handleRestoreVault(targetFolder);
        }).open();
      },
    });

    // File & folder context menus
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, abstractFile) => {
        if (abstractFile instanceof TFile && abstractFile.extension === 'md') {
          menu.addItem((item) =>
            item
              .setTitle('Share to Notion')
              .setIcon('share-2')
              .onClick(() => void this.handleShareNote(abstractFile))
          );
          menu.addItem((item) =>
            item
              .setTitle('Copy Notion share link')
              .setIcon('link')
              .onClick(() => void this.handleCopyShareLink(abstractFile))
          );
        } else if (abstractFile instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Backup folder to Notion')
              .setIcon('cloud-upload')
              .onClick(() => void this.handleBackupVault(abstractFile.path))
          );
        }
      })
    );

    this.addSettingTab(new ObsidianNotionSettingTab(this.app, this));
    this.configureAutoBackupTimer();
  }

  onunload(): void {
    this.clearAutoBackupTimer();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  configureAutoBackupTimer(): void {
    this.clearAutoBackupTimer();
    const mins = this.settings.autoBackupIntervalMinutes;
    if (mins > 0) {
      this.autoBackupTimerId = window.setInterval(
        () => {
          if (!this.isSyncing && this.settings.notionToken && this.settings.backupRootPageId) {
            void this.handleBackupVault(undefined, true);
          }
        },
        mins * 60 * 1000
      );
      this.registerInterval(this.autoBackupTimerId);
    }
  }

  private clearAutoBackupTimer(): void {
    if (this.autoBackupTimerId !== null) {
      window.clearInterval(this.autoBackupTimerId);
      this.autoBackupTimerId = null;
    }
  }

  private createEngine(): SyncEngine {
    if (!this.settings.notionToken) {
      throw new Error('Notion integration token is not configured. Open plugin settings.');
    }
    const vault = new ObsidianVaultAdapter(this.app);
    const notion = new NotionClient({
      token: this.settings.notionToken,
      transport: new ObsidianHttpTransport(),
    });
    return new SyncEngine(vault, notion, this.settings);
  }

  private setStatusText(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }

  private async handleShareNote(file: TFile): Promise<void> {
    if (this.isSyncing) {
      new Notice('A Notion sync is already in progress.');
      return;
    }
    this.isSyncing = true;
    this.setStatusText(`Notion: sharing ${file.basename}...`);

    try {
      const engine = this.createEngine();
      const res = await engine.shareNote(file.path);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.url).catch(() => {});
      }
      const action = res.created ? 'Shared' : res.skipped ? 'Up to date' : 'Updated';
      new Notice(`${action} "${file.basename}" on Notion! Link copied to clipboard.`);
    } catch (err) {
      new Notice(`Failed to share note: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSyncing = false;
      this.setStatusText('');
    }
  }

  private async handleCopyShareLink(file: TFile): Promise<void> {
    const store = new StateStore(new ObsidianVaultAdapter(this.app), this.settings.stateFilePath);
    const state = await store.load();
    const record = state.shares[file.path];
    if (!record?.url) {
      new Notice(`"${file.basename}" has not been shared to Notion yet.`);
      return;
    }
    await navigator.clipboard.writeText(record.url);
    new Notice('Notion share link copied to clipboard.');
  }

  private async handleUnshareNote(file: TFile): Promise<void> {
    if (this.isSyncing) {
      new Notice('A Notion sync is already in progress.');
      return;
    }
    this.isSyncing = true;
    this.setStatusText(`Notion: unsharing ${file.basename}...`);

    try {
      const engine = this.createEngine();
      const removed = await engine.unshareNote(file.path);
      if (removed) {
        new Notice(`Unshared "${file.basename}" (page archived in Notion).`);
      } else {
        new Notice(`"${file.basename}" was not shared to Notion.`);
      }
    } catch (err) {
      new Notice(`Failed to unshare note: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSyncing = false;
      this.setStatusText('');
    }
  }

  private async handleBackupVault(folder?: string, silent = false): Promise<void> {
    if (this.isSyncing) {
      if (!silent) new Notice('A Notion sync is already in progress.');
      return;
    }
    this.isSyncing = true;
    this.setStatusText('Notion: backing up...');

    try {
      const engine = this.createEngine();
      const res = await engine.backupVault({
        folder,
        onProgress: (ev) => {
          if (ev.total > 0) {
            this.setStatusText(`Notion: ${ev.phase} (${ev.current}/${ev.total})`);
          } else {
            this.setStatusText(`Notion: ${ev.message}`);
          }
        },
      });
      if (!silent || res.errors.length > 0) {
        const errSuffix = res.errors.length > 0 ? `, ${res.errors.length} errors` : '';
        new Notice(
          `Notion backup complete: ${res.created} created, ${res.updated} updated, ${res.skipped} unchanged${errSuffix}.`
        );
      }
    } catch (err) {
      new Notice(`Notion backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSyncing = false;
      this.setStatusText('');
    }
  }

  private async handleRestoreVault(targetPrefix: string): Promise<void> {
    if (this.isSyncing) {
      new Notice('A Notion sync is already in progress.');
      return;
    }
    this.isSyncing = true;
    this.setStatusText('Notion: restoring...');

    try {
      const engine = this.createEngine();
      const res = await engine.restoreVault(new ObsidianVaultAdapter(this.app), {
        targetPrefix,
        onProgress: (ev) => {
          this.setStatusText(`Notion: ${ev.message}`);
        },
      });
      new Notice(
        `Restored ${res.notesRestored} notes and ${res.attachmentsRestored} attachments into "${targetPrefix || 'vault root'}".`
      );
    } catch (err) {
      new Notice(`Notion restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSyncing = false;
      this.setStatusText('');
    }
  }
}

class RestoreTargetModal extends Modal {
  private targetFolder = 'Notion Restore';

  constructor(
    app: App,
    private readonly onConfirm: (folder: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Restore from Notion Backup' });
    contentEl.createEl('p', {
      text: 'Choose a subfolder inside your vault for restored notes so active files are not overwritten unintentionally.',
    });

    new Setting(contentEl)
      .setName('Destination folder')
      .addText((text) =>
        text.setValue(this.targetFolder).onChange((value) => {
          this.targetFolder = value.trim();
        })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Start Restore')
        .setCta()
        .onClick(async () => {
          this.close();
          await this.onConfirm(this.targetFolder);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
