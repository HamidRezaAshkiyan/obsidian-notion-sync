import { notionBlocksToObsidianMarkdown } from '../markdown/notion-to-obsidian.js';
import { obsidianMarkdownToNotionBlocks } from '../markdown/obsidian-to-notion.js';
import { NotionApiError, NotionBlockWithChildren, NotionClient } from '../notion/client.js';
import { StateStore } from '../state/state-store.js';
import {
  BackupOptions,
  BackupResult,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_STATE_FILE,
  RestoreOptions,
  RestoreResult,
  ShareResult,
  SyncConfig,
  SyncState,
  SyncStatus,
  VaultAdapter,
} from '../types.js';
import {
  getBasenameWithoutExt,
  getDirname,
  getMimeType,
  getNotionMediaType,
  isExcludedPath,
  normalizeNotionId,
  sanitizeFilename,
} from '../utils/notion-id.js';

export class SyncEngine {
  private readonly stateStore: StateStore;
  private readonly excludePatterns: string[];

  constructor(
    private readonly vault: VaultAdapter,
    private readonly notion: NotionClient,
    private readonly config: SyncConfig
  ) {
    this.stateStore = new StateStore(vault, config.stateFilePath ?? DEFAULT_STATE_FILE);
    this.excludePatterns =
      config.excludePatterns.length > 0 ? config.excludePatterns : DEFAULT_EXCLUDE_PATTERNS;
  }

  private requireBackupRootId(): string {
    const id = normalizeNotionId(this.config.backupRootPageId);
    if (!id) {
      throw new Error('Invalid or missing Backup Root Page ID in configuration.');
    }
    return id;
  }

  private requireShareParentId(): string {
    const id = normalizeNotionId(this.config.shareParentId);
    if (!id) {
      throw new Error('Invalid or missing Share Parent Page/Database ID in configuration.');
    }
    return id;
  }

  /**
   * Share (or update an existing shared copy of) a single Obsidian note inside the public Share Parent.
   */
  async shareNote(notePath: string, options?: { force?: boolean }): Promise<ShareResult> {
    const shareParentId = this.requireShareParentId();
    const state = await this.stateStore.load();
    const markdown = await this.vault.readText(notePath);
    const contentHash = await this.stateStore.computeNoteHash(notePath, markdown);
    const title = getBasenameWithoutExt(notePath);
    const existing = state.shares[notePath];

    if (existing && !options?.force && existing.contentHash === contentHash) {
      return {
        notePath,
        pageId: existing.pageId,
        url: existing.url,
        created: false,
        skipped: true,
      };
    }

    const converted = await obsidianMarkdownToNotionBlocks(markdown, {
      includeFrontmatter: false,
      resolvePageId: async (target) => this.resolveSyncedPageId(target, notePath, state.shares),
      uploadAttachment: async (target) => this.uploadVaultAttachment(target, notePath),
    });

    let pageId: string;
    let url: string;
    let created = false;

    if (existing) {
      try {
        const updated = await this.notion.updatePageTitle(
          existing.pageId,
          title,
          this.config.shareParentType,
          shareParentId
        );
        await this.notion.replacePageBlocks(existing.pageId, converted.blocks);
        pageId = updated.id;
        url = updated.url || existing.url;
      } catch (err) {
        if (err instanceof NotionApiError && (err.status === 404 || err.status === 400)) {
          const fresh = await this.notion.createPage(
            shareParentId,
            this.config.shareParentType,
            title
          );
          await this.notion.appendBlockChildren(fresh.id, converted.blocks);
          pageId = fresh.id;
          url = fresh.url;
          created = true;
        } else {
          throw err;
        }
      }
    } else {
      const fresh = await this.notion.createPage(
        shareParentId,
        this.config.shareParentType,
        title
      );
      await this.notion.appendBlockChildren(fresh.id, converted.blocks);
      pageId = fresh.id;
      url = fresh.url;
      created = true;
    }

    const now = new Date().toISOString();
    state.shares[notePath] = {
      pageId,
      url,
      contentHash,
      lastSyncedAt: now,
      title,
    };
    await this.stateStore.save(state);

    if (this.config.writeFrontmatterOnShare) {
      await this.vault.updateFrontmatter(notePath, (fm) => {
        fm.notion_url = url;
        fm.notion_shared_at = now;
      });
    }

    return { notePath, pageId, url, created, skipped: false };
  }

  /**
   * Archive a previously shared note in Notion and remove it from share state.
   */
  async unshareNote(notePath: string): Promise<boolean> {
    const state = await this.stateStore.load();
    const existing = state.shares[notePath];
    if (!existing) return false;

    try {
      await this.notion.archivePage(existing.pageId);
    } catch (err) {
      if (!(err instanceof NotionApiError && err.status === 404)) {
        throw err;
      }
    }

    delete state.shares[notePath];
    await this.stateStore.save(state);

    if (this.config.writeFrontmatterOnShare && (await this.vault.exists(notePath))) {
      await this.vault.updateFrontmatter(notePath, (fm) => {
        delete fm.notion_url;
        delete fm.notion_shared_at;
      });
    }

    return true;
  }

  /**
   * Incrementally back up the entire vault (or a specific subfolder) to the Private Backup Root Page
   * using a two-pass strategy so inter-note `[[wikilinks]]` resolve to live Notion page mentions.
   */
  async backupVault(options: BackupOptions = {}): Promise<BackupResult> {
    const backupRootId = this.requireBackupRootId();
    const progress = options.onProgress;
    const state = await this.stateStore.load();

    progress?.({ phase: 'scanning', current: 0, total: 0, message: 'Scanning vault...' });

    const allFiles = await this.vault.listMarkdownFiles();
    const folderPrefix = options.folder
      ? options.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : null;

    const targetFiles = allFiles
      .filter((p) => !isExcludedPath(p, this.excludePatterns))
      .filter((p) => (!folderPrefix ? true : p.startsWith(folderPrefix)))
      .sort();

    const result: BackupResult = {
      totalScanned: targetFiles.length,
      created: 0,
      updated: 0,
      skipped: 0,
      archived: 0,
      errors: [],
    };

    // Pass 1A: Ensure all required folder container pages exist in topological order
    const requiredFolders = new Set<string>();
    for (const filePath of targetFiles) {
      let dir = getDirname(filePath);
      while (dir) {
        requiredFolders.add(dir);
        dir = getDirname(dir);
      }
    }

    const sortedFolders = Array.from(requiredFolders).sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
    );

    for (let i = 0; i < sortedFolders.length; i++) {
      const folderPath = sortedFolders[i];
      if (!state.folders[folderPath]) {
        progress?.({
          phase: 'preparing-folders',
          current: i + 1,
          total: sortedFolders.length,
          message: `Creating folder: ${folderPath}`,
        });
        const parentDir = getDirname(folderPath);
        const parentPageId = parentDir ? state.folders[parentDir] : backupRootId;
        const folderName = folderPath.split('/').pop() ?? folderPath;
        const page = await this.notion.createPage(parentPageId, 'page', folderName, {
          iconEmoji: '📁',
        });
        state.folders[folderPath] = page.id;
        await this.stateStore.save(state);
      }
    }

    // Pass 1B: Pre-create empty page shells for brand new notes so Pass 2 can cross-link them
    const newlyCreatedPaths = new Set<string>();
    const newFiles = targetFiles.filter((p) => !state.backups[p]);
    for (let i = 0; i < newFiles.length; i++) {
      const filePath = newFiles[i];
      const title = getBasenameWithoutExt(filePath);
      const dir = getDirname(filePath);
      const parentPageId = dir ? state.folders[dir] : backupRootId;

      progress?.({
        phase: 'creating-shells',
        current: i + 1,
        total: newFiles.length,
        message: `Creating page shell: ${filePath}`,
      });

      try {
        const page = await this.notion.createPage(parentPageId, 'page', title);
        state.backups[filePath] = {
          pageId: page.id,
          url: page.url,
          contentHash: '', // Empty hash guarantees Pass 2 populates it
          lastSyncedAt: '',
          title,
        };
        newlyCreatedPaths.add(filePath);
        await this.stateStore.save(state);
      } catch (err) {
        result.errors.push({
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Pass 2: Upload content for new or changed notes
    for (let i = 0; i < targetFiles.length; i++) {
      const filePath = targetFiles[i];
      const record = state.backups[filePath];
      if (!record) continue; // Failed during shell creation

      progress?.({
        phase: 'uploading',
        current: i + 1,
        total: targetFiles.length,
        message: `Syncing ${filePath}`,
      });

      try {
        const markdown = await this.vault.readText(filePath);
        const contentHash = await this.stateStore.computeNoteHash(filePath, markdown);

        if (!options.force && record.contentHash === contentHash) {
          result.skipped += 1;
          continue;
        }

        const title = getBasenameWithoutExt(filePath);
        const converted = await obsidianMarkdownToNotionBlocks(markdown, {
          includeFrontmatter: this.config.includeFrontmatterInBackup,
          resolvePageId: async (target) => this.resolveSyncedPageId(target, filePath, state.backups),
          uploadAttachment: async (target) => this.uploadVaultAttachment(target, filePath),
        });

        const isNew = newlyCreatedPaths.has(filePath);
        if (isNew) {
          await this.notion.appendBlockChildren(record.pageId, converted.blocks);
          result.created += 1;
        } else {
          try {
            await this.notion.updatePageTitle(record.pageId, title, 'page');
            await this.notion.replacePageBlocks(record.pageId, converted.blocks);
          } catch (err) {
            if (err instanceof NotionApiError && (err.status === 404 || err.status === 400)) {
              // Page was deleted manually in Notion; recreate it
              const dir = getDirname(filePath);
              const parentPageId = dir ? state.folders[dir] : backupRootId;
              const fresh = await this.notion.createPage(parentPageId, 'page', title);
              await this.notion.appendBlockChildren(fresh.id, converted.blocks);
              record.pageId = fresh.id;
              record.url = fresh.url;
            } else {
              throw err;
            }
          }
          result.updated += 1;
        }

        record.contentHash = contentHash;
        record.lastSyncedAt = new Date().toISOString();
        record.title = title;
        await this.stateStore.save(state);
      } catch (err) {
        result.errors.push({
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Optional cleanup of deleted local notes (only on full-vault backup)
    if (this.config.archiveDeletedInBackup && !folderPrefix) {
      const currentSet = new Set(targetFiles);
      const deletedPaths = Object.keys(state.backups).filter((p) => !currentSet.has(p));

      for (let i = 0; i < deletedPaths.length; i++) {
        const deletedPath = deletedPaths[i];
        progress?.({
          phase: 'archiving',
          current: i + 1,
          total: deletedPaths.length,
          message: `Archiving deleted note: ${deletedPath}`,
        });
        try {
          await this.notion.archivePage(state.backups[deletedPath].pageId);
          delete state.backups[deletedPath];
          result.archived += 1;
          await this.stateStore.save(state);
        } catch (err) {
          if (err instanceof NotionApiError && err.status === 404) {
            delete state.backups[deletedPath];
            await this.stateStore.save(state);
          } else {
            result.errors.push({
              path: deletedPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    progress?.({
      phase: 'done',
      current: targetFiles.length,
      total: targetFiles.length,
      message: 'Backup complete',
    });

    return result;
  }

  /**
   * Restore all pages & folder hierarchy from the Private Backup Root Page into a target VaultAdapter.
   */
  async restoreVault(
    targetVault: VaultAdapter = this.vault,
    options: RestoreOptions = {}
  ): Promise<RestoreResult> {
    const backupRootId = this.requireBackupRootId();
    const prefix = options.targetPrefix
      ? options.targetPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : '';

    const result: RestoreResult = {
      notesRestored: 0,
      attachmentsRestored: 0,
      errors: [],
    };

    const walkPage = async (pageId: string, currentDir: string): Promise<void> => {
      const blocks = await this.notion.getBlockTree(pageId);
      const childPages = blocks.filter((b) => b.type === 'child_page');

      for (const childBlock of childPages) {
        const childId = childBlock.id;
        if (!childId) continue;
        const childData = childBlock.child_page as { title?: string } | undefined;
        const rawTitle = childData?.title ?? 'Untitled';
        const safeName = sanitizeFilename(rawTitle);

        options.onProgress?.({
          phase: 'restoring',
          current: result.notesRestored,
          total: 0,
          message: `Restoring ${currentDir ? `${currentDir}/` : ''}${safeName}`,
        });

        try {
          const grandChildren = await this.notion.getBlockTree(childId);
          const nestedPages = grandChildren.filter((b) => b.type === 'child_page');
          const contentBlocks = grandChildren.filter(
            (b) => b.type !== 'child_page' && b.type !== 'child_database'
          );

          const isPureFolder = nestedPages.length > 0 && contentBlocks.length === 0;

          if (!isPureFolder) {
            const noteRelPath = [prefix, currentDir, `${safeName}.md`]
              .filter(Boolean)
              .join('/');
            const markdown = await notionBlocksToObsidianMarkdown(contentBlocks, {
              downloadAttachment: async (url, suggestedName) => {
                try {
                  const bytes = await this.notion.downloadBinary(url);
                  const safeFile = sanitizeFilename(suggestedName);
                  const attachmentRelPath = [prefix, 'attachments', safeFile]
                    .filter(Boolean)
                    .join('/');
                  await targetVault.writeBinary(attachmentRelPath, bytes);
                  result.attachmentsRestored += 1;
                  return `attachments/${safeFile}`;
                } catch {
                  return null;
                }
              },
            });
            await targetVault.writeText(noteRelPath, markdown);
            result.notesRestored += 1;
          }

          if (nestedPages.length > 0) {
            const nextDir = currentDir ? `${currentDir}/${safeName}` : safeName;
            await walkPage(childId, nextDir);
          }
        } catch (err) {
          result.errors.push({
            title: rawTitle,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await walkPage(backupRootId, '');

    options.onProgress?.({
      phase: 'done',
      current: result.notesRestored,
      total: result.notesRestored,
      message: `Restored ${result.notesRestored} notes`,
    });

    return result;
  }

  /**
   * Inspect local vault vs. sync state without making any Notion API calls.
   */
  async getStatus(): Promise<SyncStatus> {
    const state = await this.stateStore.load();
    const allFiles = (await this.vault.listMarkdownFiles()).filter(
      (p) => !isExcludedPath(p, this.excludePatterns)
    );
    const currentSet = new Set(allFiles);

    let backedUpUnchanged = 0;
    let backedUpModified = 0;
    let notBackedUp = 0;

    for (const filePath of allFiles) {
      const record = state.backups[filePath];
      if (!record) {
        notBackedUp += 1;
        continue;
      }
      const markdown = await this.vault.readText(filePath);
      const hash = await this.stateStore.computeNoteHash(filePath, markdown);
      if (hash === record.contentHash) {
        backedUpUnchanged += 1;
      } else {
        backedUpModified += 1;
      }
    }

    const deletedLocally = Object.keys(state.backups).filter((p) => !currentSet.has(p)).length;
    const sharedNotes = Object.entries(state.shares).map(([path, rec]) => ({
      path,
      url: rec.url,
      lastSyncedAt: rec.lastSyncedAt,
    }));

    return {
      totalNotes: allFiles.length,
      backedUpUnchanged,
      backedUpModified,
      notBackedUp,
      deletedLocally,
      sharedNotes,
    };
  }

  private async resolveSyncedPageId(
    target: string,
    fromNotePath: string,
    map: SyncState['backups']
  ): Promise<string | null> {
    const resolved = await this.vault.resolveLink(target, fromNotePath);
    if (resolved && map[resolved]?.pageId) {
      return map[resolved].pageId;
    }
    // Fallback: match by note basename if unambiguous
    const normalized = target.toLowerCase().replace(/\.md$/, '');
    for (const [notePath, record] of Object.entries(map)) {
      const base = getBasenameWithoutExt(notePath).toLowerCase();
      if (base === normalized || notePath.toLowerCase() === `${normalized}.md`) {
        return record.pageId;
      }
    }
    return null;
  }

  private async uploadVaultAttachment(
    target: string,
    fromNotePath: string
  ): Promise<{
    fileUploadId: string;
    filename: string;
    mediaType: 'image' | 'pdf' | 'audio' | 'video' | 'file';
  } | null> {
    const resolved = await this.vault.resolveLink(target, fromNotePath);
    if (!resolved || !(await this.vault.exists(resolved))) {
      return null;
    }

    const bytes = await this.vault.readBinary(resolved);
    const filename = resolved.split('/').pop() ?? target;
    const mimeType = getMimeType(resolved);
    const mediaType = getNotionMediaType(resolved);
    const fileUploadId = await this.notion.uploadFile(filename, mimeType, bytes);

    return { fileUploadId, filename, mediaType };
  }
}
