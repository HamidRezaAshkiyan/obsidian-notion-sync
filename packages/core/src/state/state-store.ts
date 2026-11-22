import { extractReferencedAttachments } from '../markdown/obsidian-to-notion.js';
import { DEFAULT_STATE_FILE, SyncState, VaultAdapter } from '../types.js';
import { sha256Hex } from '../utils/notion-id.js';

export function createEmptyState(): SyncState {
  return {
    version: 1,
    folders: {},
    backups: {},
    shares: {},
  };
}

export class StateStore {
  private readonly statePath: string;

  constructor(
    private readonly vault: VaultAdapter,
    stateFilePath: string = DEFAULT_STATE_FILE
  ) {
    this.statePath = stateFilePath;
  }

  async load(): Promise<SyncState> {
    const exists = await this.vault.exists(this.statePath);
    if (!exists) {
      return createEmptyState();
    }

    try {
      const raw = await this.vault.readText(this.statePath);
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      return {
        version: 1,
        folders: parsed.folders ?? {},
        backups: parsed.backups ?? {},
        shares: parsed.shares ?? {},
      };
    } catch {
      return createEmptyState();
    }
  }

  async save(state: SyncState): Promise<void> {
    const serialized = JSON.stringify(state, null, 2) + '\n';
    await this.vault.writeText(this.statePath, serialized);
  }

  /**
   * Computes a deterministic SHA-256 fingerprint combining the note's Markdown text
   * and the bytes of all local attachments it embeds, so editing either the note or
   * an embedded image triggers a re-sync.
   */
  async computeNoteHash(notePath: string, markdown: string): Promise<string> {
    const attachmentTargets = extractReferencedAttachments(markdown).sort();
    const parts: string[] = [markdown];

    for (const target of attachmentTargets) {
      const resolved = await this.vault.resolveLink(target, notePath);
      if (resolved && (await this.vault.exists(resolved))) {
        try {
          const bytes = await this.vault.readBinary(resolved);
          const fileHash = await sha256Hex(bytes);
          parts.push(`attachment:${resolved}:${fileHash}`);
        } catch {
          parts.push(`attachment:${resolved}:unreadable`);
        }
      }
    }

    return sha256Hex(parts.join('\n---\n'));
  }
}
