import { HttpTransport, NotionBlock, ShareParentType } from '../types.js';
import { buildMultipartFormData } from './multipart.js';
import { RateLimiter, RateLimiterOptions } from './rate-limiter.js';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_API_VERSION = '2026-03-11';
const MAX_BLOCKS_PER_APPEND = 100;
const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const MULTI_PART_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MB

export class NotionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly body?: string
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export interface NotionPageResponse {
  id: string;
  url: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, unknown>;
}

export interface NotionBlockWithChildren extends NotionBlock {
  children?: NotionBlockWithChildren[];
}

export interface NotionClientOptions {
  token: string;
  transport: HttpTransport;
  rateLimiter?: RateLimiterOptions;
  apiVersion?: string;
}

export class NotionClient {
  private readonly token: string;
  private readonly transport: HttpTransport;
  private readonly limiter: RateLimiter;
  private readonly apiVersion: string;

  constructor(options: NotionClientOptions) {
    this.token = options.token;
    this.transport = options.transport;
    this.limiter = new RateLimiter(options.rateLimiter);
    this.apiVersion = options.apiVersion ?? NOTION_API_VERSION;
  }

  private getAuthHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Notion-Version': this.apiVersion,
      ...extra,
    };
  }

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${NOTION_API_BASE}${path}`;
    const headers = this.getAuthHeaders(
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined
    );
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;

    return this.limiter.schedule(async () => {
      const response = await this.transport.request({
        url,
        method,
        headers,
        body: serialized,
      });

      const retryAfterRaw = response.headers['retry-after'] ?? response.headers['Retry-After'];
      const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : undefined;

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        const errText = await response.text().catch(() => '');
        return {
          status: response.status,
          retryAfterSeconds,
          error: new NotionApiError(
            `Notion API ${method} ${path} failed with HTTP ${response.status}: ${errText}`,
            response.status,
            undefined,
            errText
          ),
        };
      }

      if (response.status < 200 || response.status >= 300) {
        const errText = await response.text().catch(() => '');
        let code: string | undefined;
        let message = errText;
        try {
          const parsed = JSON.parse(errText) as { code?: string; message?: string };
          code = parsed.code;
          message = parsed.message ?? errText;
        } catch {
          // ignore non-JSON body
        }
        throw new NotionApiError(
          `Notion API ${method} ${path} failed (${response.status}${code ? ` ${code}` : ''}): ${message}`,
          response.status,
          code,
          errText
        );
      }

      const data = (await response.json()) as T;
      return { status: response.status, value: data };
    });
  }

  private async requestMultipart<T>(
    url: string,
    contentType: string,
    body: Uint8Array
  ): Promise<T> {
    const headers = this.getAuthHeaders({ 'Content-Type': contentType });

    return this.limiter.schedule(async () => {
      const response = await this.transport.request({
        url,
        method: 'POST',
        headers,
        body,
      });

      const retryAfterRaw = response.headers['retry-after'] ?? response.headers['Retry-After'];
      const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : undefined;

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        const errText = await response.text().catch(() => '');
        return {
          status: response.status,
          retryAfterSeconds,
          error: new NotionApiError(
            `Notion file upload failed with HTTP ${response.status}: ${errText}`,
            response.status,
            undefined,
            errText
          ),
        };
      }

      if (response.status < 200 || response.status >= 300) {
        const errText = await response.text().catch(() => '');
        throw new NotionApiError(
          `Notion file upload failed (${response.status}): ${errText}`,
          response.status,
          undefined,
          errText
        );
      }

      const data = (await response.json()) as T;
      return { status: response.status, value: data };
    });
  }

  async testConnection(): Promise<{ botName: string; workspaceName?: string }> {
    const me = await this.requestJson<{
      name?: string;
      bot?: { workspace_name?: string };
    }>('GET', '/users/me');
    return {
      botName: me.name ?? 'Notion Integration',
      workspaceName: me.bot?.workspace_name,
    };
  }

  async getPage(pageId: string): Promise<NotionPageResponse> {
    return this.requestJson<NotionPageResponse>('GET', `/pages/${pageId}`);
  }

  async createPage(
    parentId: string,
    parentType: ShareParentType,
    title: string,
    options?: {
      iconEmoji?: string;
      extraProperties?: Record<string, unknown>;
    }
  ): Promise<NotionPageResponse> {
    const parent =
      parentType === 'database' ? { database_id: parentId } : { page_id: parentId };

    // For database parents, find the title property name (usually "Name" or "Title"); default to "title" for pages.
    let titlePropName = 'title';
    if (parentType === 'database') {
      titlePropName = await this.resolveDatabaseTitleProperty(parentId);
    }

    const properties: Record<string, unknown> = {
      ...(options?.extraProperties ?? {}),
      [titlePropName]: {
        title: [{ type: 'text', text: { content: title } }],
      },
    };

    const payload: Record<string, unknown> = { parent, properties };
    if (options?.iconEmoji) {
      payload.icon = { type: 'emoji', emoji: options.iconEmoji };
    }

    return this.requestJson<NotionPageResponse>('POST', '/pages', payload);
  }

  private databaseTitlePropCache = new Map<string, string>();

  private async resolveDatabaseTitleProperty(databaseId: string): Promise<string> {
    const cached = this.databaseTitlePropCache.get(databaseId);
    if (cached) return cached;

    try {
      const db = await this.requestJson<{
        properties?: Record<string, { type?: string }>;
      }>('GET', `/databases/${databaseId}`);
      if (db.properties) {
        for (const [propName, propDef] of Object.entries(db.properties)) {
          if (propDef?.type === 'title') {
            this.databaseTitlePropCache.set(databaseId, propName);
            return propName;
          }
        }
      }
    } catch {
      // Fallback to standard Notion database title property name
    }
    return 'Name';
  }

  async updatePageTitle(
    pageId: string,
    title: string,
    parentType: ShareParentType = 'page',
    databaseId?: string
  ): Promise<NotionPageResponse> {
    const titlePropName =
      parentType === 'database' && databaseId
        ? await this.resolveDatabaseTitleProperty(databaseId)
        : 'title';

    return this.requestJson<NotionPageResponse>('PATCH', `/pages/${pageId}`, {
      archived: false,
      properties: {
        [titlePropName]: {
          title: [{ type: 'text', text: { content: title } }],
        },
      },
    });
  }

  async archivePage(pageId: string): Promise<void> {
    await this.requestJson('PATCH', `/pages/${pageId}`, { archived: true });
  }

  async listBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const results: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const query = cursor
        ? `/blocks/${blockId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${blockId}/children?page_size=100`;

      const page = await this.requestJson<{
        results: NotionBlock[];
        has_more: boolean;
        next_cursor?: string | null;
      }>('GET', query);

      results.push(...page.results);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);

    return results;
  }

  async getBlockTree(blockId: string): Promise<NotionBlockWithChildren[]> {
    const children = await this.listBlockChildren(blockId);
    const enriched: NotionBlockWithChildren[] = [];

    for (const block of children) {
      const copy: NotionBlockWithChildren = { ...block };
      if (block.has_children && block.id && block.type !== 'child_page' && block.type !== 'child_database') {
        copy.children = await this.getBlockTree(block.id);
      }
      enriched.push(copy);
    }

    return enriched;
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.requestJson('DELETE', `/blocks/${blockId}`);
  }

  /**
   * Appends blocks to a parent block/page, automatically chunking at 100 blocks per request
   * and recursively appending deeply nested children (>2 levels, which Notion rejects inline).
   */
  async appendBlockChildren(parentBlockId: string, blocks: NotionBlock[]): Promise<void> {
    if (blocks.length === 0) return;

    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_APPEND) {
      const slice = blocks.slice(i, i + MAX_BLOCKS_PER_APPEND);
      const { sanitized, deferred } = this.splitDeepChildren(slice);

      const response = await this.requestJson<{ results: NotionBlock[] }>(
        'PATCH',
        `/blocks/${parentBlockId}/children`,
        { children: sanitized }
      );

      if (deferred.length > 0 && response.results) {
        for (const item of deferred) {
          const createdBlock = response.results[item.index];
          if (createdBlock?.id) {
            await this.appendBlockChildren(createdBlock.id, item.children);
          }
        }
      }
    }
  }

  /**
   * Notion allows up to 2 levels of nested children in a single append call (except `table`
   * which requires its `table_row` children inline). To be completely safe, we keep 1 level
   * of `table_row` inline and defer nested children on list/toggle/callout/quote blocks
   * that themselves have grandchildren.
   */
  private splitDeepChildren(blocks: NotionBlock[]): {
    sanitized: NotionBlock[];
    deferred: Array<{ index: number; children: NotionBlock[] }>;
  } {
    const sanitized: NotionBlock[] = [];
    const deferred: Array<{ index: number; children: NotionBlock[] }> = [];

    blocks.forEach((block, index) => {
      const type = block.type;
      const payload = block[type] as Record<string, unknown> | undefined;

      if (
        payload &&
        Array.isArray(payload.children) &&
        payload.children.length > 0 &&
        type !== 'table'
      ) {
        const childBlocks = payload.children as NotionBlock[];
        // Always defer children of blocks that have grandchildren or >100 children
        const needsDefer =
          childBlocks.length > MAX_BLOCKS_PER_APPEND ||
          childBlocks.some((child) => {
            const childPayload = child[child.type] as Record<string, unknown> | undefined;
            return Array.isArray(childPayload?.children) && childPayload.children.length > 0;
          });

        if (needsDefer) {
          const clonedPayload = { ...payload };
          delete clonedPayload.children;
          sanitized.push({ ...block, [type]: clonedPayload });
          deferred.push({ index, children: childBlocks });
          return;
        }
      }

      sanitized.push(block);
    });

    return { sanitized, deferred };
  }

  /**
   * Replaces all content blocks on a page while preserving any `child_page` or `child_database` blocks.
   */
  async replacePageBlocks(pageId: string, newBlocks: NotionBlock[]): Promise<void> {
    const existing = await this.listBlockChildren(pageId);
    for (const block of existing) {
      if (block.id && block.type !== 'child_page' && block.type !== 'child_database') {
        await this.deleteBlock(block.id);
      }
    }
    await this.appendBlockChildren(pageId, newBlocks);
  }

  /**
   * Uploads a local binary file to Notion via the 3-step Direct File Upload API.
   * Returns the `file_upload` ID to reference in image/pdf/audio/video/file blocks.
   */
  async uploadFile(
    filename: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<string> {
    if (bytes.byteLength <= SINGLE_PART_MAX_BYTES) {
      const created = await this.requestJson<{
        id: string;
        upload_url?: string;
      }>('POST', '/file_uploads', {
        mode: 'single_part',
        filename,
        content_type: mimeType,
      });

      const uploadUrl = created.upload_url ?? `${NOTION_API_BASE}/file_uploads/${created.id}/send`;
      const multipart = buildMultipartFormData([
        { name: 'file', filename, contentType: mimeType, data: bytes },
      ]);
      await this.requestMultipart(uploadUrl, multipart.contentType, multipart.body);
      return created.id;
    }

    // Multi-part upload for files > 20 MB
    const numberOfParts = Math.ceil(bytes.byteLength / MULTI_PART_CHUNK_BYTES);
    const created = await this.requestJson<{
      id: string;
      upload_url?: string;
    }>('POST', '/file_uploads', {
      mode: 'multi_part',
      filename,
      content_type: mimeType,
      number_of_parts: numberOfParts,
    });

    const uploadUrl = created.upload_url ?? `${NOTION_API_BASE}/file_uploads/${created.id}/send`;
    for (let partIndex = 0; partIndex < numberOfParts; partIndex++) {
      const start = partIndex * MULTI_PART_CHUNK_BYTES;
      const end = Math.min(start + MULTI_PART_CHUNK_BYTES, bytes.byteLength);
      const chunk = bytes.subarray(start, end);
      const multipart = buildMultipartFormData([
        { name: 'part_number', value: String(partIndex + 1) },
        { name: 'file', filename, contentType: mimeType, data: chunk },
      ]);
      await this.requestMultipart(uploadUrl, multipart.contentType, multipart.body);
    }

    await this.requestJson('POST', `/file_uploads/${created.id}/complete`);
    return created.id;
  }

  /**
   * Downloads raw bytes from a URL (used during `restore` to download Notion-hosted attachments).
   */
  async downloadBinary(url: string): Promise<Uint8Array> {
    const response = await this.transport.request({ url, method: 'GET' });
    if (response.status < 200 || response.status >= 300) {
      throw new NotionApiError(
        `Failed to download attachment (${response.status}): ${url}`,
        response.status
      );
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }
}
