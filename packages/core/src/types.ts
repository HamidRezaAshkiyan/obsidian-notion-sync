export type ShareParentType = 'page' | 'database';

export interface SyncConfig {
  notionToken: string;
  backupRootPageId: string;
  shareParentId: string;
  shareParentType: ShareParentType;
  /** Write `notion_url` and `notion_shared_at` into YAML frontmatter when sharing a note. */
  writeFrontmatterOnShare: boolean;
  /** Preserve YAML frontmatter inside a collapsible toggle block in Notion backup pages so restore is lossless. */
  includeFrontmatterInBackup: boolean;
  /** Archive Notion backup pages whose corresponding local files were deleted. */
  archiveDeletedInBackup: boolean;
  /** Glob-like path patterns to exclude from backup. */
  excludePatterns: string[];
  /** Relative path of the sync state file inside the vault. Defaults to `.obsidian-notion-state.json`. */
  stateFilePath?: string;
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '.obsidian/**',
  '.trash/**',
  '.git/**',
  'node_modules/**',
];

export const DEFAULT_STATE_FILE = '.obsidian-notion-state.json';

export interface SyncedNoteRecord {
  pageId: string;
  url: string;
  contentHash: string;
  lastSyncedAt: string;
  title: string;
}

export interface SyncState {
  version: 1;
  /** Maps vault-relative folder path (e.g. "Projects/Work") -> Notion page ID */
  folders: Record<string, string>;
  /** Maps vault-relative note path (e.g. "Projects/Work/Spec.md") -> Backup record */
  backups: Record<string, SyncedNoteRecord>;
  /** Maps vault-relative note path -> Share record */
  shares: Record<string, SyncedNoteRecord>;
}

export interface HttpRequestOptions {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpTransport {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export interface VaultAdapter {
  /** List all Markdown file paths relative to vault root using forward slashes. */
  listMarkdownFiles(): Promise<string[]>;
  /** Read UTF-8 text from a vault-relative path. */
  readText(relativePath: string): Promise<string>;
  /** Write UTF-8 text to a vault-relative path (creating parent directories as needed). */
  writeText(relativePath: string, content: string): Promise<void>;
  /** Read binary bytes from a vault-relative path. */
  readBinary(relativePath: string): Promise<Uint8Array>;
  /** Write binary bytes to a vault-relative path (creating parent directories as needed). */
  writeBinary(relativePath: string, data: Uint8Array): Promise<void>;
  /** Check if a vault-relative file exists. */
  exists(relativePath: string): Promise<boolean>;
  /**
   * Resolve an Obsidian link or embed target (e.g. "image.png", "Notes/Spec", "../img.jpg")
   * from a source note path into a vault-relative file path, or null if not found.
   */
  resolveLink(target: string, fromNotePath: string): Promise<string | null>;
  /**
   * Update YAML frontmatter on a note safely. If `updater` deletes a key or sets it to `undefined`,
   * that key is removed from frontmatter.
   */
  updateFrontmatter(
    relativePath: string,
    updater: (frontmatter: Record<string, unknown>) => void
  ): Promise<void>;
}

export type SyncProgressPhase =
  | 'scanning'
  | 'preparing-folders'
  | 'creating-shells'
  | 'uploading'
  | 'archiving'
  | 'restoring'
  | 'done';

export interface SyncProgressEvent {
  phase: SyncProgressPhase;
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (event: SyncProgressEvent) => void;

export interface ShareResult {
  notePath: string;
  pageId: string;
  url: string;
  created: boolean;
  skipped: boolean;
}

export interface BackupOptions {
  force?: boolean;
  folder?: string;
  onProgress?: ProgressCallback;
}

export interface BackupResult {
  totalScanned: number;
  created: number;
  updated: number;
  skipped: number;
  archived: number;
  errors: Array<{ path: string; error: string }>;
}

export interface RestoreOptions {
  /** Target subfolder prefix inside the destination VaultAdapter (defaults to root ""). */
  targetPrefix?: string;
  onProgress?: ProgressCallback;
}

export interface RestoreResult {
  notesRestored: number;
  attachmentsRestored: number;
  errors: Array<{ title: string; error: string }>;
}

export interface SyncStatus {
  totalNotes: number;
  backedUpUnchanged: number;
  backedUpModified: number;
  notBackedUp: number;
  deletedLocally: number;
  sharedNotes: Array<{ path: string; url: string; lastSyncedAt: string }>;
}

// Notion Block & Rich Text minimal structural types (strict enough for safety, flexible for API evolution)
export interface NotionRichTextAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

export interface NotionRichText {
  type: 'text' | 'equation' | 'mention';
  text?: {
    content: string;
    link?: { url: string } | null;
  };
  equation?: {
    expression: string;
  };
  mention?: {
    type: 'page';
    page: { id: string };
  };
  annotations?: NotionRichTextAnnotations;
  plain_text?: string;
  href?: string | null;
}

export interface NotionBlock {
  object?: 'block';
  id?: string;
  type: string;
  has_children?: boolean;
  // Dynamic type payload (e.g., paragraph, heading_1, callout, image, etc.)
  [key: string]: unknown;
}
