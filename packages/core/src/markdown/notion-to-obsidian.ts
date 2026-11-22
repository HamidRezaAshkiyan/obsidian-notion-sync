import { NotionBlockWithChildren } from '../notion/client.js';
import { NotionRichText } from '../types.js';
import { FRONTMATTER_TOGGLE_MARKER } from './obsidian-to-notion.js';

export interface NotionToObsidianOptions {
  /**
   * Optional callback to download a Notion-hosted attachment URL and return its local
   * vault-relative path (e.g. `attachments/photo.png`).
   */
  downloadAttachment?: (url: string, suggestedFilename: string) => Promise<string | null>;
}

const EMOJI_TO_CALLOUT: Record<string, string> = {
  '📝': 'note',
  'ℹ️': 'info',
  '📋': 'abstract',
  '☑️': 'todo',
  '💡': 'tip',
  '🔥': 'important',
  '✅': 'success',
  '❓': 'question',
  '⚠️': 'warning',
  '❌': 'failure',
  '🚨': 'danger',
  '🐛': 'bug',
  '🧪': 'example',
  '💬': 'quote',
};

/**
 * Converts a Notion block tree back into clean Obsidian Markdown.
 */
export async function notionBlocksToObsidianMarkdown(
  blocks: NotionBlockWithChildren[],
  options: NotionToObsidianOptions = {}
): Promise<string> {
  let frontmatterBlock: string | null = null;
  const bodyLines: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Recover preserved YAML frontmatter toggle if present at the top
    if (i === 0 && block.type === 'toggle') {
      const toggle = block.toggle as { rich_text?: NotionRichText[] } | undefined;
      const title = richTextToPlain(toggle?.rich_text ?? []).trim();
      if (title === FRONTMATTER_TOGGLE_MARKER && block.children && block.children.length > 0) {
        const firstChild = block.children[0];
        if (firstChild.type === 'code') {
          const code = firstChild.code as { rich_text?: NotionRichText[] } | undefined;
          const yamlText = richTextToPlain(code?.rich_text ?? []);
          frontmatterBlock = `---\n${yamlText.trim()}\n---`;
          continue;
        }
      }
    }

    const rendered = await renderBlock(block, 0, options);
    if (rendered !== null) {
      bodyLines.push(rendered);
    }
  }

  const parts: string[] = [];
  if (frontmatterBlock) {
    parts.push(frontmatterBlock);
  }
  if (bodyLines.length > 0) {
    parts.push(bodyLines.join('\n\n'));
  }

  return parts.join('\n\n') + '\n';
}

async function renderBlock(
  block: NotionBlockWithChildren,
  indentLevel: number,
  options: NotionToObsidianOptions
): Promise<string | null> {
  const indent = '  '.repeat(indentLevel);

  switch (block.type) {
    case 'heading_1': {
      const data = block.heading_1 as { rich_text?: NotionRichText[] };
      return `${indent}# ${richTextToMarkdown(data?.rich_text ?? [])}`;
    }
    case 'heading_2': {
      const data = block.heading_2 as { rich_text?: NotionRichText[] };
      return `${indent}## ${richTextToMarkdown(data?.rich_text ?? [])}`;
    }
    case 'heading_3': {
      const data = block.heading_3 as { rich_text?: NotionRichText[] };
      return `${indent}### ${richTextToMarkdown(data?.rich_text ?? [])}`;
    }
    case 'paragraph': {
      const data = block.paragraph as { rich_text?: NotionRichText[] };
      const text = richTextToMarkdown(data?.rich_text ?? []);
      return `${indent}${text}`;
    }
    case 'bulleted_list_item': {
      const data = block.bulleted_list_item as { rich_text?: NotionRichText[] };
      const line = `${indent}- ${richTextToMarkdown(data?.rich_text ?? [])}`;
      const children = await renderChildren(block.children, indentLevel + 1, options);
      return children ? `${line}\n${children}` : line;
    }
    case 'numbered_list_item': {
      const data = block.numbered_list_item as { rich_text?: NotionRichText[] };
      const line = `${indent}1. ${richTextToMarkdown(data?.rich_text ?? [])}`;
      const children = await renderChildren(block.children, indentLevel + 1, options);
      return children ? `${line}\n${children}` : line;
    }
    case 'to_do': {
      const data = block.to_do as { rich_text?: NotionRichText[]; checked?: boolean };
      const mark = data?.checked ? 'x' : ' ';
      const line = `${indent}- [${mark}] ${richTextToMarkdown(data?.rich_text ?? [])}`;
      const children = await renderChildren(block.children, indentLevel + 1, options);
      return children ? `${line}\n${children}` : line;
    }
    case 'code': {
      const data = block.code as { language?: string; rich_text?: NotionRichText[] };
      const lang = data?.language && data.language !== 'plain text' ? data.language : '';
      const codeText = richTextToPlain(data?.rich_text ?? []);
      return `${indent}\`\`\`${lang}\n${codeText}\n${indent}\`\`\``;
    }
    case 'equation': {
      const data = block.equation as { expression?: string };
      return `${indent}$$\n${data?.expression ?? ''}\n${indent}$$`;
    }
    case 'divider':
      return `${indent}---`;
    case 'quote': {
      const data = block.quote as { rich_text?: NotionRichText[] };
      const mainText = richTextToMarkdown(data?.rich_text ?? []);
      const lines = mainText.split('\n').map((l) => `${indent}> ${l}`);
      if (block.children && block.children.length > 0) {
        const nested = await renderChildren(block.children, 0, options);
        for (const l of nested.split('\n')) {
          lines.push(`${indent}> ${l}`);
        }
      }
      return lines.join('\n');
    }
    case 'callout': {
      const data = block.callout as {
        rich_text?: NotionRichText[];
        icon?: { type?: string; emoji?: string };
      };
      const emoji = data?.icon?.emoji ?? '';
      const calloutType = EMOJI_TO_CALLOUT[emoji] ?? 'note';
      const title = richTextToPlain(data?.rich_text ?? []).trim();
      const lines = [`${indent}> [!${calloutType}]${title ? ` ${title}` : ''}`];
      if (block.children && block.children.length > 0) {
        const nested = await renderChildren(block.children, 0, options);
        for (const l of nested.split('\n')) {
          lines.push(`${indent}> ${l}`);
        }
      }
      return lines.join('\n');
    }
    case 'toggle': {
      const data = block.toggle as { rich_text?: NotionRichText[] };
      const title = richTextToMarkdown(data?.rich_text ?? []);
      const nested = await renderChildren(block.children, 0, options);
      const lines = [`${indent}> [!note]- ${title}`];
      if (nested) {
        for (const l of nested.split('\n')) {
          lines.push(`${indent}> ${l}`);
        }
      }
      return lines.join('\n');
    }
    case 'table': {
      const rows = block.children ?? [];
      if (rows.length === 0) return null;
      const mdRows: string[] = [];
      rows.forEach((row, rowIdx) => {
        const rowData = row.table_row as { cells?: NotionRichText[][] } | undefined;
        const cells = (rowData?.cells ?? []).map((cell) =>
          richTextToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n/g, '<br>')
        );
        mdRows.push(`${indent}| ${cells.join(' | ')} |`);
        if (rowIdx === 0) {
          mdRows.push(`${indent}| ${cells.map(() => '---').join(' | ')} |`);
        }
      });
      return mdRows.join('\n');
    }
    case 'bookmark': {
      const data = block.bookmark as { url?: string; caption?: NotionRichText[] };
      const url = data?.url ?? '';
      const caption = richTextToPlain(data?.caption ?? []).trim();
      return `${indent}[${caption || url}](${url})`;
    }
    case 'image':
    case 'pdf':
    case 'audio':
    case 'video':
    case 'file': {
      const data = block[block.type] as {
        type?: string;
        external?: { url?: string };
        file?: { url?: string };
        caption?: NotionRichText[];
        name?: string;
      };
      const caption = richTextToPlain(data?.caption ?? []).trim();
      if (data?.type === 'external' && data.external?.url) {
        return block.type === 'image'
          ? `${indent}![${caption}](${data.external.url})`
          : `${indent}[${caption || data.external.url}](${data.external.url})`;
      }
      const hostedUrl = data?.file?.url;
      if (hostedUrl) {
        const suggestedName = extractFilenameFromUrl(hostedUrl, data?.name || `${block.type}.bin`);
        if (options.downloadAttachment) {
          const localPath = await options.downloadAttachment(hostedUrl, suggestedName);
          if (localPath) {
            return `${indent}![[${localPath}]]`;
          }
        }
        return `${indent}[${caption || suggestedName}](${hostedUrl})`;
      }
      return null;
    }
    case 'child_page':
    case 'child_database':
      // Handled by the recursive vault restorer at the folder/page level
      return null;
    default:
      return null;
  }
}

async function renderChildren(
  children: NotionBlockWithChildren[] | undefined,
  indentLevel: number,
  options: NotionToObsidianOptions
): Promise<string> {
  if (!children || children.length === 0) return '';
  const rendered: string[] = [];
  for (const child of children) {
    const text = await renderBlock(child, indentLevel, options);
    if (text !== null) rendered.push(text);
  }
  return rendered.join('\n');
}

function richTextToPlain(items: NotionRichText[]): string {
  return items
    .map((item) => {
      if (item.plain_text !== undefined) return item.plain_text;
      if (item.type === 'text') return item.text?.content ?? '';
      if (item.type === 'equation') return item.equation?.expression ?? '';
      return '';
    })
    .join('');
}

function richTextToMarkdown(items: NotionRichText[]): string {
  return items
    .map((item) => {
      if (item.type === 'equation') {
        const expr = item.equation?.expression ?? item.plain_text ?? '';
        return `$${expr}$`;
      }
      if (item.type === 'mention' && item.mention?.type === 'page') {
        const label = item.plain_text?.trim() || item.mention.page.id;
        return `[[${label}]]`;
      }

      let content = item.text?.content ?? item.plain_text ?? '';
      if (!content) return '';

      const ann = item.annotations ?? {};
      const href = item.text?.link?.url ?? item.href ?? null;

      if (ann.code) {
        content = `\`${content}\``;
      } else {
        if (ann.bold) content = `**${content}**`;
        if (ann.italic) content = `*${content}*`;
        if (ann.strikethrough) content = `~~${content}~~`;
        if (ann.color === 'yellow_background') content = `==${content}==`;
      }

      if (href) {
        content = `[${content}](${href})`;
      }

      return content;
    })
    .join('');
}

function extractFilenameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').pop();
    if (segment && segment.includes('.')) {
      return decodeURIComponent(segment);
    }
  } catch {
    // ignore malformed URL
  }
  return fallback;
}
