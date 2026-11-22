/**
 * Extracts a formatted UUID (8-4-4-4-12) from a raw Notion ID or a full Notion URL.
 * Returns null if no valid 32-hex ID is found.
 */
export function normalizeNotionId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Match either hyphenated UUID or 32 contiguous hex characters (preferring the last match in URLs)
  const uuidMatch = trimmed.match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g
  );
  if (uuidMatch && uuidMatch.length > 0) {
    return uuidMatch[uuidMatch.length - 1].toLowerCase();
  }

  const hexMatches = trimmed.match(/([0-9a-fA-F]{32})/g);
  if (hexMatches && hexMatches.length > 0) {
    const raw = hexMatches[hexMatches.length - 1].toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }

  return null;
}

/**
 * Computes a SHA-256 hex digest using standard Web Crypto (available in Node 20+ and Electron/Obsidian).
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Simple glob matcher supporting `*`, `**`, and `?` over POSIX-style relative paths.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

  let regexStr = '^';
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i];
    if (ch === '*') {
      if (normalizedPattern[i + 1] === '*') {
        if (normalizedPattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
          continue;
        }
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr).test(normalizedPath);
}

export function isExcludedPath(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}

export function getExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function getBasenameWithoutExt(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function getDirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'Untitled';
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
};

export function getMimeType(filePath: string): string {
  const ext = getExtension(filePath);
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export type NotionMediaBlockType = 'image' | 'pdf' | 'audio' | 'video' | 'file';

export function getNotionMediaType(filePath: string): NotionMediaBlockType {
  const ext = getExtension(filePath);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'ico'].includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') return 'pdf';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  return 'file';
}
