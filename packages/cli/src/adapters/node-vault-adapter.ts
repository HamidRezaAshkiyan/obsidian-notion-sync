import { getDirname, VaultAdapter } from '@obsidian-notion-sync/core';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * VaultAdapter backed by Node.js `fs/promises` with Obsidian-compatible shortest-path
 * wikilink and attachment resolution.
 */
export class NodeVaultAdapter implements VaultAdapter {
  private readonly rootDir: string;
  private fileIndexCache: string[] | null = null;

  constructor(vaultRootPath: string) {
    this.rootDir = path.resolve(vaultRootPath);
  }

  private resolveAbs(relativePath: string): string {
    return path.join(this.rootDir, relativePath);
  }

  private toPosix(p: string): string {
    return p.split(path.sep).join('/');
  }

  async listMarkdownFiles(): Promise<string[]> {
    const all = await this.listAllFiles();
    return all.filter((p) => p.toLowerCase().endsWith('.md'));
  }

  private async listAllFiles(forceRefresh = false): Promise<string[]> {
    if (this.fileIndexCache && !forceRefresh) {
      return this.fileIndexCache;
    }
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          results.push(this.toPosix(path.relative(this.rootDir, full)));
        }
      }
    };
    await walk(this.rootDir);
    this.fileIndexCache = results;
    return results;
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.resolveAbs(relativePath), 'utf8');
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const abs = this.resolveAbs(relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    this.fileIndexCache = null;
  }

  async readBinary(relativePath: string): Promise<Uint8Array> {
    const buf = await readFile(this.resolveAbs(relativePath));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeBinary(relativePath: string, data: Uint8Array): Promise<void> {
    const abs = this.resolveAbs(relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    this.fileIndexCache = null;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.resolveAbs(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async resolveLink(target: string, fromNotePath: string): Promise<string | null> {
    const cleaned = target.replace(/\\/g, '/').replace(/^\.\//, '');

    // 1. Direct path relative to vault root
    if (await this.exists(cleaned)) return cleaned;
    if (!cleaned.includes('.') && (await this.exists(`${cleaned}.md`))) {
      return `${cleaned}.md`;
    }

    // 2. Relative to the source note's directory
    const dir = getDirname(fromNotePath);
    if (dir) {
      const joined = this.toPosix(path.posix.normalize(`${dir}/${cleaned}`));
      if (!joined.startsWith('..')) {
        if (await this.exists(joined)) return joined;
        if (!joined.includes('.') && (await this.exists(`${joined}.md`))) {
          return `${joined}.md`;
        }
      }
    }

    // 3. Obsidian shortest-path match across the entire vault
    const allFiles = await this.listAllFiles();
    const targetLower = cleaned.toLowerCase();
    const targetMdLower = targetLower.endsWith('.md') ? targetLower : `${targetLower}.md`;

    for (const file of allFiles) {
      const lower = file.toLowerCase();
      if (lower === targetLower || lower === targetMdLower) return file;
      const base = lower.split('/').pop() ?? '';
      if (base === targetLower || base === targetMdLower) return file;
    }

    return null;
  }

  async updateFrontmatter(
    relativePath: string,
    updater: (frontmatter: Record<string, unknown>) => void
  ): Promise<void> {
    const content = await this.readText(relativePath);
    const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
    const match = content.match(fmRegex);

    let fm: Record<string, unknown> = {};
    let body = content;

    if (match) {
      try {
        const parsed = parseYaml(match[1]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          fm = parsed as Record<string, unknown>;
        }
      } catch {
        fm = {};
      }
      body = content.slice(match[0].length);
    }

    updater(fm);

    for (const key of Object.keys(fm)) {
      if (fm[key] === undefined) {
        delete fm[key];
      }
    }

    let nextContent: string;
    if (Object.keys(fm).length === 0) {
      nextContent = body;
    } else {
      const serializedFm = stringifyYaml(fm).trimEnd();
      nextContent = `---\n${serializedFm}\n---\n${body}`;
    }

    await this.writeText(relativePath, nextContent);
  }
}
