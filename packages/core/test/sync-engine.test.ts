import { describe, expect, it } from 'vitest';
import { NotionClient } from '../src/notion/client.js';
import { SyncEngine } from '../src/sync/sync-engine.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  NotionBlock,
  SyncConfig,
  VaultAdapter,
} from '../src/types.js';

class MemoryVault implements VaultAdapter {
  textFiles = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();

  async listMarkdownFiles(): Promise<string[]> {
    return Array.from(this.textFiles.keys()).filter((p) => p.endsWith('.md'));
  }

  async readText(relativePath: string): Promise<string> {
    const val = this.textFiles.get(relativePath);
    if (val === undefined) throw new Error(`File not found: ${relativePath}`);
    return val;
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    this.textFiles.set(relativePath, content);
  }

  async readBinary(relativePath: string): Promise<Uint8Array> {
    const val = this.binaryFiles.get(relativePath);
    if (!val) throw new Error(`Binary not found: ${relativePath}`);
    return val;
  }

  async writeBinary(relativePath: string, data: Uint8Array): Promise<void> {
    this.binaryFiles.set(relativePath, data);
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.textFiles.has(relativePath) || this.binaryFiles.has(relativePath);
  }

  async resolveLink(target: string): Promise<string | null> {
    if (this.textFiles.has(target) || this.binaryFiles.has(target)) return target;
    if (this.textFiles.has(`${target}.md`)) return `${target}.md`;
    for (const key of [...this.textFiles.keys(), ...this.binaryFiles.keys()]) {
      const base = key.split('/').pop() ?? '';
      if (base === target || base === `${target}.md`) return key;
    }
    return null;
  }

  async updateFrontmatter(
    relativePath: string,
    updater: (fm: Record<string, unknown>) => void
  ): Promise<void> {
    const content = this.textFiles.get(relativePath) ?? '';
    const fmRegex = /^---\n([\s\S]*?)\n---\n?/;
    const match = content.match(fmRegex);
    const fm: Record<string, unknown> = {};
    let body = content;
    if (match) {
      for (const line of match[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      body = content.slice(match[0].length);
    }
    updater(fm);
    const entries = Object.entries(fm).filter(([, v]) => v !== undefined);
    const serialized =
      entries.length > 0
        ? `---\n${entries.map(([k, v]) => `${k}: ${String(v)}`).join('\n')}\n---\n${body}`
        : body;
    this.textFiles.set(relativePath, serialized);
  }
}

interface MockPage {
  id: string;
  parentId: string;
  title: string;
  url: string;
  archived: boolean;
  blocks: NotionBlock[];
}

class MockNotionTransport implements HttpTransport {
  pages = new Map<string, MockPage>();
  uploads = new Map<string, Uint8Array>();
  fail429Once = false;
  requestCount = 0;
  private idCounter = 1;

  private nextUuid(): string {
    const hex = String(this.idCounter++).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }

  private jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse {
    const text = JSON.stringify(data);
    return {
      status,
      headers,
      text: async () => text,
      json: async <T = unknown>() => data as T,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  }

  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    this.requestCount += 1;

    if (this.fail429Once) {
      this.fail429Once = false;
      return this.jsonResponse(429, { message: 'Rate limited' }, { 'retry-after': '0' });
    }

    const url = new URL(options.url);
    const pathname = url.pathname;

    // Attachment download mock
    if (url.hostname === 'mock-cdn.notion.so') {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      return {
        status: 200,
        headers: {},
        text: async () => '',
        json: async <T = unknown>() => ({}) as T,
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    }

    // POST /v1/file_uploads
    if (options.method === 'POST' && pathname === '/v1/file_uploads') {
      const id = `fu-${this.idCounter++}`;
      return this.jsonResponse(200, {
        id,
        upload_url: `https://api.notion.com/v1/file_uploads/${id}/send`,
        status: 'pending',
      });
    }

    // POST /v1/file_uploads/:id/send
    const uploadSendMatch = pathname.match(/^\/v1\/file_uploads\/([^/]+)\/send$/);
    if (options.method === 'POST' && uploadSendMatch) {
      const id = uploadSendMatch[1];
      this.uploads.set(id, options.body instanceof Uint8Array ? options.body : new Uint8Array());
      return this.jsonResponse(200, { id, status: 'uploaded' });
    }

    // POST /v1/pages
    if (options.method === 'POST' && pathname === '/v1/pages') {
      const body = JSON.parse(options.body as string) as {
        parent: { page_id?: string; database_id?: string };
        properties: { title?: { title: Array<{ text: { content: string } }> } };
      };
      const id = this.nextUuid();
      const parentId = body.parent.page_id ?? body.parent.database_id ?? '';
      const title = body.properties?.title?.title?.[0]?.text?.content ?? 'Untitled';
      const page: MockPage = {
        id,
        parentId,
        title,
        url: `https://www.notion.so/${id.replace(/-/g, '')}`,
        archived: false,
        blocks: [],
      };
      this.pages.set(id, page);

      // Register child_page block inside parent if parent exists
      const parent = this.pages.get(parentId);
      if (parent) {
        parent.blocks.push({
          object: 'block',
          id,
          type: 'child_page',
          has_children: true,
          child_page: { title },
        });
      }

      return this.jsonResponse(200, { id: page.id, url: page.url });
    }

    // PATCH /v1/pages/:id
    const pagePatchMatch = pathname.match(/^\/v1\/pages\/([^/]+)$/);
    if (options.method === 'PATCH' && pagePatchMatch) {
      const page = this.pages.get(pagePatchMatch[1]);
      if (!page) return this.jsonResponse(404, { code: 'object_not_found' });
      const body = JSON.parse(options.body as string) as {
        archived?: boolean;
        properties?: { title?: { title: Array<{ text: { content: string } }> } };
      };
      if (typeof body.archived === 'boolean') page.archived = body.archived;
      if (body.properties?.title?.title?.[0]?.text?.content) {
        page.title = body.properties.title.title[0].text.content;
      }
      return this.jsonResponse(200, { id: page.id, url: page.url, archived: page.archived });
    }

    // GET /v1/blocks/:id/children
    const childrenGetMatch = pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (options.method === 'GET' && childrenGetMatch) {
      const page = this.pages.get(childrenGetMatch[1]);
      const results = page ? page.blocks : [];
      return this.jsonResponse(200, { results, has_more: false, next_cursor: null });
    }

    // PATCH /v1/blocks/:id/children
    const childrenPatchMatch = pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (options.method === 'PATCH' && childrenPatchMatch) {
      const page = this.pages.get(childrenPatchMatch[1]);
      const body = JSON.parse(options.body as string) as { children: NotionBlock[] };
      const created = body.children.map((b) => ({ ...b, id: this.nextUuid() }));
      if (page) {
        page.blocks.push(...created);
      }
      return this.jsonResponse(200, { results: created });
    }

    // DELETE /v1/blocks/:id
    const blockDeleteMatch = pathname.match(/^\/v1\/blocks\/([^/]+)$/);
    if (options.method === 'DELETE' && blockDeleteMatch) {
      const targetId = blockDeleteMatch[1];
      for (const page of this.pages.values()) {
        page.blocks = page.blocks.filter((b) => b.id !== targetId);
      }
      return this.jsonResponse(200, { id: targetId, archived: true });
    }

    return this.jsonResponse(404, { message: `Unhandled mock route: ${options.method} ${pathname}` });
  }
}

const BACKUP_ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARE_ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeConfig(): SyncConfig {
  return {
    notionToken: 'test-token',
    backupRootPageId: BACKUP_ROOT,
    shareParentId: SHARE_ROOT,
    shareParentType: 'page',
    writeFrontmatterOnShare: true,
    includeFrontmatterInBackup: true,
    archiveDeletedInBackup: true,
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  };
}

describe('SyncEngine integration', () => {
  it('performs two-pass incremental vault backup with cross-note wikilinks, attachments, and 429 retry', async () => {
    const vault = new MemoryVault();
    vault.textFiles.set('Projects/Alpha.md', '# Alpha\n\nLinks to [[Beta]] and embeds ![[pic.png]].');
    vault.textFiles.set('Projects/Beta.md', '# Beta\n\nBack to [[Alpha]].');
    vault.binaryFiles.set('Projects/pic.png', new Uint8Array([1, 2, 3, 4]));

    const transport = new MockNotionTransport();
    transport.pages.set(BACKUP_ROOT, {
      id: BACKUP_ROOT,
      parentId: '',
      title: 'Backup Root',
      url: 'https://www.notion.so/backup',
      archived: false,
      blocks: [],
    });
    transport.fail429Once = true;

    const client = new NotionClient({
      token: 'test-token',
      transport,
      rateLimiter: { requestsPerSecond: 1000, sleep: async () => {} },
    });
    const engine = new SyncEngine(vault, client, makeConfig());

    // First backup creates folder + both notes
    const res1 = await engine.backupVault();
    expect(res1.created).toBe(2);
    expect(res1.updated).toBe(0);
    expect(res1.skipped).toBe(0);
    expect(res1.errors).toEqual([]);
    expect(transport.uploads.size).toBe(1);

    // Verify Alpha's Notion blocks contain a live page mention to Beta's pageId
    const state = JSON.parse(await vault.readText('.obsidian-notion-state.json'));
    const alphaPage = transport.pages.get(state.backups['Projects/Alpha.md'].pageId)!;
    const betaPageId = state.backups['Projects/Beta.md'].pageId;
    const paraBlock = alphaPage.blocks.find((b) => b.type === 'paragraph')!;
    const richText = (paraBlock.paragraph as { rich_text: Array<{ type: string; mention?: { page: { id: string } } }> }).rich_text;
    expect(richText.some((rt) => rt.type === 'mention' && rt.mention?.page.id === betaPageId)).toBe(true);

    // Second backup with no changes skips both notes
    const res2 = await engine.backupVault();
    expect(res2.created).toBe(0);
    expect(res2.updated).toBe(0);
    expect(res2.skipped).toBe(2);

    // Edit Beta and re-run: only Beta updates
    vault.textFiles.set('Projects/Beta.md', '# Beta Updated\n\nNew content.');
    const res3 = await engine.backupVault();
    expect(res3.updated).toBe(1);
    expect(res3.skipped).toBe(1);
  });

  it('shares a note, writes frontmatter notion_url, updates in place, and unshares cleanly', async () => {
    const vault = new MemoryVault();
    vault.textFiles.set('Public Post.md', '# Hello World\n\nDraft 1.');

    const transport = new MockNotionTransport();
    const client = new NotionClient({
      token: 'test-token',
      transport,
      rateLimiter: { requestsPerSecond: 1000, sleep: async () => {} },
    });
    const engine = new SyncEngine(vault, client, makeConfig());

    const share1 = await engine.shareNote('Public Post.md');
    expect(share1.created).toBe(true);
    expect(share1.url).toContain('https://www.notion.so/');

    // Frontmatter updated with notion_url
    const updatedMd = await vault.readText('Public Post.md');
    expect(updatedMd).toContain(`notion_url: ${share1.url}`);

    // Modify body and re-share -> preserves same pageId & URL
    vault.textFiles.set('Public Post.md', updatedMd + '\nDraft 2.');
    const share2 = await engine.shareNote('Public Post.md');
    expect(share2.created).toBe(false);
    expect(share2.pageId).toBe(share1.pageId);
    expect(share2.url).toBe(share1.url);

    // Unshare archives page and removes notion_url from frontmatter
    const unshared = await engine.unshareNote('Public Post.md');
    expect(unshared).toBe(true);
    expect(transport.pages.get(share1.pageId)?.archived).toBe(true);
    expect(await vault.readText('Public Post.md')).not.toContain('notion_url:');
  });

  it('restores folders, notes, and attachments from Notion backup into a fresh vault', async () => {
    const sourceVault = new MemoryVault();
    const restoreVault = new MemoryVault();
    const transport = new MockNotionTransport();

    const folderId = '11111111-1111-4111-8111-111111111111';
    const noteId = '22222222-2222-4222-8222-222222222222';

    transport.pages.set(BACKUP_ROOT, {
      id: BACKUP_ROOT,
      parentId: '',
      title: 'Backup Root',
      url: 'https://www.notion.so/backup',
      archived: false,
      blocks: [
        { object: 'block', id: folderId, type: 'child_page', has_children: true, child_page: { title: 'Notes' } },
      ],
    });
    transport.pages.set(folderId, {
      id: folderId,
      parentId: BACKUP_ROOT,
      title: 'Notes',
      url: 'https://www.notion.so/notes',
      archived: false,
      blocks: [
        { object: 'block', id: noteId, type: 'child_page', has_children: true, child_page: { title: 'Restored' } },
      ],
    });
    transport.pages.set(noteId, {
      id: noteId,
      parentId: folderId,
      title: 'Restored',
      url: 'https://www.notion.so/restored',
      archived: false,
      blocks: [
        {
          object: 'block',
          id: 'blk-1',
          type: 'heading_1',
          heading_1: { rich_text: [{ type: 'text', text: { content: 'Welcome Back' } }] },
        },
        {
          object: 'block',
          id: 'blk-2',
          type: 'image',
          image: { type: 'file', file: { url: 'https://mock-cdn.notion.so/files/shot.png' } },
        },
      ],
    });

    const client = new NotionClient({
      token: 'test-token',
      transport,
      rateLimiter: { requestsPerSecond: 1000, sleep: async () => {} },
    });
    const engine = new SyncEngine(sourceVault, client, makeConfig());

    const res = await engine.restoreVault(restoreVault);
    expect(res.notesRestored).toBe(1);
    expect(res.attachmentsRestored).toBe(1);
    expect(res.errors).toEqual([]);

    const restoredNote = await restoreVault.readText('Notes/Restored.md');
    expect(restoredNote).toContain('# Welcome Back');
    expect(restoredNote).toContain('![[attachments/shot.png]]');
    expect(await restoreVault.exists('attachments/shot.png')).toBe(true);
  });
});
