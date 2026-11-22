import { getDirname, VaultAdapter } from '@obsidian-notion-sync/core';
import { App, normalizePath, TFile } from 'obsidian';

/**
 * VaultAdapter backed by Obsidian's native Vault, MetadataCache, and FileManager APIs.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly app: App) {}

  async listMarkdownFiles(): Promise<string[]> {
    return this.app.vault.getMarkdownFiles().map((f) => f.path);
  }

  async readText(relativePath: string): Promise<string> {
    const normalized = normalizePath(relativePath);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    // Fall back to adapter.read for hidden dotfiles like `.obsidian-notion-state.json`
    return this.app.vault.adapter.read(normalized);
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const normalized = normalizePath(relativePath);
    await this.ensureParentDirs(normalized);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
      return;
    }
    if (normalized.startsWith('.')) {
      await this.app.vault.adapter.write(normalized, content);
      return;
    }
    if (await this.app.vault.adapter.exists(normalized)) {
      await this.app.vault.adapter.write(normalized, content);
    } else {
      await this.app.vault.create(normalized, content);
    }
  }

  async readBinary(relativePath: string): Promise<Uint8Array> {
    const normalized = normalizePath(relativePath);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      const buf = await this.app.vault.readBinary(file);
      return new Uint8Array(buf);
    }
    const buf = await this.app.vault.adapter.readBinary(normalized);
    return new Uint8Array(buf);
  }

  async writeBinary(relativePath: string, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(relativePath);
    await this.ensureParentDirs(normalized);
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    await this.app.vault.adapter.writeBinary(normalized, buf);
  }

  async exists(relativePath: string): Promise<boolean> {
    const normalized = normalizePath(relativePath);
    return this.app.vault.adapter.exists(normalized);
  }

  async resolveLink(target: string, fromNotePath: string): Promise<string | null> {
    const dest = this.app.metadataCache.getFirstLinkpathDest(target, fromNotePath);
    if (dest) return dest.path;

    // Fallback: direct relative path check
    const normalized = normalizePath(target);
    if (await this.app.vault.adapter.exists(normalized)) {
      return normalized;
    }
    const dir = getDirname(fromNotePath);
    if (dir) {
      const joined = normalizePath(`${dir}/${target}`);
      if (await this.app.vault.adapter.exists(joined)) {
        return joined;
      }
    }
    return null;
  }

  async updateFrontmatter(
    relativePath: string,
    updater: (frontmatter: Record<string, unknown>) => void
  ): Promise<void> {
    const normalized = normalizePath(relativePath);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      updater(fm as Record<string, unknown>);
    });
  }

  private async ensureParentDirs(normalizedPath: string): Promise<void> {
    const dir = getDirname(normalizedPath);
    if (!dir) return;
    const parts = dir.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }
}
