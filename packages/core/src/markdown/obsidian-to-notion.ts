import type {
  Blockquote,
  Code,
  Heading,
  Image,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
  YAML,
} from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';
import { NotionBlock, NotionRichText, NotionRichTextAnnotations } from '../types.js';
import { getNotionMediaType } from '../utils/notion-id.js';

const MAX_RICH_TEXT_LENGTH = 2000;
export const FRONTMATTER_TOGGLE_MARKER = 'Obsidian Frontmatter';

export interface ObsidianToNotionOptions {
  /** Whether to include YAML frontmatter as a collapsible toggle block (for lossless backup/restore). */
  includeFrontmatter?: boolean;
  /** Given a wikilink target (e.g. "My Note" or "Folder/My Note"), return its Notion page ID if synced. */
  resolvePageId?: (target: string) => Promise<string | null> | string | null;
  /**
   * Given a local attachment target (e.g. "image.png" or "assets/doc.pdf"), upload it and return
   * `{ fileUploadId, filename, mediaType }`, or null if unavailable.
   */
  uploadAttachment?: (
    target: string
  ) => Promise<{
    fileUploadId: string;
    filename: string;
    mediaType: 'image' | 'pdf' | 'audio' | 'video' | 'file';
  } | null>;
}

export interface ConvertedMarkdown {
  frontmatter: Record<string, unknown> | null;
  rawFrontmatter: string | null;
  blocks: NotionBlock[];
  referencedAttachments: string[];
}

interface CalloutStyle {
  emoji: string;
  color: string;
}

const CALLOUT_STYLES: Record<string, CalloutStyle> = {
  note: { emoji: '📝', color: 'blue_background' },
  info: { emoji: 'ℹ️', color: 'blue_background' },
  abstract: { emoji: '📋', color: 'blue_background' },
  summary: { emoji: '📋', color: 'blue_background' },
  tldr: { emoji: '📋', color: 'blue_background' },
  todo: { emoji: '☑️', color: 'blue_background' },
  tip: { emoji: '💡', color: 'green_background' },
  hint: { emoji: '💡', color: 'green_background' },
  important: { emoji: '🔥', color: 'purple_background' },
  success: { emoji: '✅', color: 'green_background' },
  check: { emoji: '✅', color: 'green_background' },
  done: { emoji: '✅', color: 'green_background' },
  question: { emoji: '❓', color: 'yellow_background' },
  help: { emoji: '❓', color: 'yellow_background' },
  faq: { emoji: '❓', color: 'yellow_background' },
  warning: { emoji: '⚠️', color: 'yellow_background' },
  caution: { emoji: '⚠️', color: 'orange_background' },
  attention: { emoji: '⚠️', color: 'yellow_background' },
  failure: { emoji: '❌', color: 'red_background' },
  fail: { emoji: '❌', color: 'red_background' },
  missing: { emoji: '❌', color: 'red_background' },
  danger: { emoji: '🚨', color: 'red_background' },
  error: { emoji: '🚨', color: 'red_background' },
  bug: { emoji: '🐛', color: 'red_background' },
  example: { emoji: '🧪', color: 'purple_background' },
  quote: { emoji: '💬', color: 'gray_background' },
  cite: { emoji: '💬', color: 'gray_background' },
};

const NOTION_CODE_LANGUAGES = new Set([
  'abap', 'agda', 'arduino', 'ascii art', 'assembly', 'bash', 'basic', 'bnf', 'c', 'c#', 'c++',
  'clojure', 'coffeescript', 'coq', 'css', 'dart', 'dhall', 'diff', 'docker', 'ebnf', 'elixir',
  'elm', 'erlang', 'f#', 'flow', 'fortran', 'gherkin', 'glsl', 'go', 'graphql', 'groovy',
  'haskell', 'hcl', 'html', 'idris', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex',
  'less', 'lisp', 'livescript', 'llvm ir', 'lua', 'makefile', 'markdown', 'markup', 'matlab',
  'mathematica', 'mermaid', 'nix', 'notion formula', 'objective-c', 'ocaml', 'pascal', 'perl',
  'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'purescript', 'python', 'r', 'racket',
  'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'smalltalk', 'solidity',
  'sql', 'swift', 'toml', 'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic',
  'webassembly', 'xml', 'yaml', 'java/c/c++/c#',
]);

const CODE_LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  cs: 'c#',
  csharp: 'c#',
  cpp: 'c++',
  cxx: 'c++',
  cc: 'c++',
  dockerfile: 'docker',
  kt: 'kotlin',
  tex: 'latex',
  ps1: 'powershell',
  txt: 'plain text',
  text: 'plain text',
  jsonc: 'json',
  json5: 'json',
};

export function normalizeCodeLanguage(lang?: string | null): string {
  if (!lang) return 'plain text';
  const lower = lang.trim().toLowerCase();
  const aliased = CODE_LANG_ALIASES[lower] ?? lower;
  return NOTION_CODE_LANGUAGES.has(aliased) ? aliased : 'plain text';
}

/**
 * Splits a string into Notion rich_text objects respecting the 2,000-character limit.
 */
export function makeTextRichText(
  content: string,
  annotations?: NotionRichTextAnnotations,
  linkUrl?: string | null
): NotionRichText[] {
  if (!content) return [];
  const results: NotionRichText[] = [];
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT_LENGTH) {
    const chunk = content.slice(i, i + MAX_RICH_TEXT_LENGTH);
    const rt: NotionRichText = {
      type: 'text',
      text: {
        content: chunk,
        ...(linkUrl ? { link: { url: linkUrl } } : {}),
      },
    };
    if (annotations && Object.keys(annotations).length > 0) {
      rt.annotations = { ...annotations };
    }
    results.push(rt);
  }
  return results;
}

/**
 * Extract all local attachment references (`![[file]]` and `![alt](local-path)`) from raw Obsidian Markdown.
 * Used both for content+attachment hashing and during conversion.
 */
export function extractReferencedAttachments(markdown: string): string[] {
  const refs = new Set<string>();

  // Strip fenced code blocks before scanning so code examples aren't treated as embeds
  const stripped = markdown.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');

  // Obsidian embeds: ![[target]] or ![[target|alias/width]]
  const embedRegex = /!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = embedRegex.exec(stripped)) !== null) {
    const target = match[1].trim();
    if (target) refs.add(target);
  }

  // Standard Markdown images/links to local files: ![alt](path)
  const mdImageRegex = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((match = mdImageRegex.exec(stripped)) !== null) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (target && !/^https?:\/\//i.test(target) && !/^data:/i.test(target)) {
      refs.add(decodeURIComponent(target));
    }
  }

  return Array.from(refs);
}

/**
 * Parse Obsidian Markdown into Notion Blocks.
 */
export async function obsidianMarkdownToNotionBlocks(
  markdown: string,
  options: ObsidianToNotionOptions = {}
): Promise<ConvertedMarkdown> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkMath);

  const tree = processor.parse(markdown) as Root;
  const blocks: NotionBlock[] = [];
  const referencedAttachments = extractReferencedAttachments(markdown);

  let frontmatter: Record<string, unknown> | null = null;
  let rawFrontmatter: string | null = null;

  for (const node of tree.children) {
    if (node.type === 'yaml') {
      const yamlNode = node as YAML;
      rawFrontmatter = yamlNode.value;
      try {
        const parsed = parseYaml(yamlNode.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        frontmatter = null;
      }

      if (options.includeFrontmatter && rawFrontmatter.trim().length > 0) {
        blocks.push({
          object: 'block',
          type: 'toggle',
          toggle: {
            rich_text: makeTextRichText(FRONTMATTER_TOGGLE_MARKER),
            children: [
              {
                object: 'block',
                type: 'code',
                code: {
                  language: 'yaml',
                  rich_text: makeTextRichText(rawFrontmatter),
                },
              },
            ],
          },
        });
      }
      continue;
    }

    const converted = await convertRootNode(node, options);
    blocks.push(...converted);
  }

  return {
    frontmatter,
    rawFrontmatter,
    blocks,
    referencedAttachments,
  };
}

async function convertRootNode(
  node: RootContent,
  options: ObsidianToNotionOptions
): Promise<NotionBlock[]> {
  switch (node.type) {
    case 'heading':
      return [await convertHeading(node as Heading, options)];
    case 'paragraph':
      return await convertParagraph(node as Paragraph, options);
    case 'list':
      return await convertList(node as List, options);
    case 'blockquote':
      return [await convertBlockquote(node as Blockquote, options)];
    case 'code':
      return [convertCode(node as Code)];
    case 'thematicBreak':
      return [{ object: 'block', type: 'divider', divider: {} }];
    case 'table':
      return [await convertTable(node as Table, options)];
    default: {
      // Handle remark-math `math` block node
      const anyNode = node as unknown as { type: string; value?: string };
      if (anyNode.type === 'math' && typeof anyNode.value === 'string') {
        return [
          {
            object: 'block',
            type: 'equation',
            equation: { expression: anyNode.value.trim() },
          },
        ];
      }
      if (anyNode.type === 'html' && typeof anyNode.value === 'string') {
        const trimmed = anyNode.value.trim();
        if (!trimmed || /^<!--[\s\S]*-->$/.test(trimmed)) return [];
        return [
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'html',
              rich_text: makeTextRichText(trimmed),
            },
          },
        ];
      }
      return [];
    }
  }
}

async function convertHeading(
  node: Heading,
  options: ObsidianToNotionOptions
): Promise<NotionBlock> {
  const depth = Math.min(Math.max(node.depth, 1), 3) as 1 | 2 | 3;
  const key = `heading_${depth}`;
  const richText = await convertPhrasingNodes(
    node.children,
    node.depth > 3 ? { bold: true } : {},
    options
  );
  return {
    object: 'block',
    type: key,
    [key]: {
      rich_text: richText,
    },
  };
}

async function convertParagraph(
  node: Paragraph,
  options: ObsidianToNotionOptions
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let inlineBuffer: NotionRichText[] = [];

  const flushInline = () => {
    if (inlineBuffer.length > 0) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: inlineBuffer },
      });
      inlineBuffer = [];
    }
  };

  for (const child of node.children) {
    if (child.type === 'image') {
      flushInline();
      const mediaBlock = await convertImageNode(child as Image, options);
      if (mediaBlock) blocks.push(mediaBlock);
      continue;
    }

    if (child.type === 'text' && child.value.includes('![[')) {
      const parts = splitObsidianEmbeds(child.value);
      for (const part of parts) {
        if (part.kind === 'embed') {
          flushInline();
          const embedBlock = await convertObsidianEmbed(part.target, part.alias, options);
          if (embedBlock) blocks.push(embedBlock);
        } else if (part.text.trim().length > 0) {
          const rts = await parseObsidianInlineText(part.text, {}, null, options);
          inlineBuffer.push(...rts);
        }
      }
      continue;
    }

    const rts = await convertPhrasingNode(child, {}, null, options);
    inlineBuffer.push(...rts);
  }

  flushInline();
  return blocks;
}

function splitObsidianEmbeds(
  text: string
): Array<{ kind: 'text'; text: string } | { kind: 'embed'; target: string; alias?: string }> {
  const result: Array<
    { kind: 'text'; text: string } | { kind: 'embed'; target: string; alias?: string }
  > = [];
  const regex = /!\[\[([^\]]+?)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    const inner = match[1];
    const pipeIdx = inner.indexOf('|');
    const rawTarget = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;
    const hashIdx = rawTarget.indexOf('#');
    const target = (hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget).trim();
    result.push({ kind: 'embed', target, alias });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ kind: 'text', text: text.slice(lastIndex) });
  }

  return result;
}

async function convertImageNode(
  node: Image,
  options: ObsidianToNotionOptions
): Promise<NotionBlock | null> {
  const url = node.url.trim();
  if (/^https?:\/\//i.test(url)) {
    return {
      object: 'block',
      type: 'image',
      image: {
        type: 'external',
        external: { url },
        ...(node.alt ? { caption: makeTextRichText(node.alt) } : {}),
      },
    };
  }

  if (options.uploadAttachment) {
    const uploaded = await options.uploadAttachment(decodeURIComponent(url));
    if (uploaded) {
      return buildFileUploadBlock(uploaded.mediaType, uploaded.fileUploadId, node.alt || uploaded.filename);
    }
  }

  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: makeTextRichText(`[Image: ${node.alt || url}]`, { italic: true, color: 'gray' }),
    },
  };
}

async function convertObsidianEmbed(
  target: string,
  alias: string | undefined,
  options: ObsidianToNotionOptions
): Promise<NotionBlock | null> {
  // Check if it's an attachment (has non-md extension) or a note embed
  const isNoteEmbed = !target.includes('.') || target.toLowerCase().endsWith('.md');

  if (!isNoteEmbed && options.uploadAttachment) {
    const uploaded = await options.uploadAttachment(target);
    if (uploaded) {
      const caption = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : undefined;
      return buildFileUploadBlock(uploaded.mediaType, uploaded.fileUploadId, caption);
    }
  }

  if (isNoteEmbed && options.resolvePageId) {
    const pageId = await options.resolvePageId(target);
    if (pageId) {
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'mention',
              mention: { type: 'page', page: { id: pageId } },
            },
          ],
        },
      };
    }
  }

  const fallbackMediaType = getNotionMediaType(target);
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: makeTextRichText(`[Embedded ${fallbackMediaType}: ${alias || target}]`, {
        italic: true,
        color: 'gray',
      }),
    },
  };
}

function buildFileUploadBlock(
  mediaType: 'image' | 'pdf' | 'audio' | 'video' | 'file',
  fileUploadId: string,
  caption?: string
): NotionBlock {
  const payload: Record<string, unknown> = {
    type: 'file_upload',
    file_upload: { id: fileUploadId },
  };
  if (caption) {
    payload.caption = makeTextRichText(caption);
  }
  return {
    object: 'block',
    type: mediaType,
    [mediaType]: payload,
  };
}

async function convertList(node: List, options: ObsidianToNotionOptions): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  for (const item of node.children) {
    const converted = await convertListItem(item, Boolean(node.ordered), options);
    blocks.push(converted);
  }
  return blocks;
}

async function convertListItem(
  item: ListItem,
  ordered: boolean,
  options: ObsidianToNotionOptions
): Promise<NotionBlock> {
  const isTask = typeof item.checked === 'boolean';
  const blockType = isTask ? 'to_do' : ordered ? 'numbered_list_item' : 'bulleted_list_item';

  let primaryRichText: NotionRichText[] = [];
  const childBlocks: NotionBlock[] = [];

  let consumedFirstParagraph = false;
  for (const child of item.children) {
    if (!consumedFirstParagraph && child.type === 'paragraph') {
      consumedFirstParagraph = true;
      const para = child as Paragraph;
      primaryRichText = await convertPhrasingNodes(para.children, {}, options);
    } else {
      const nested = await convertRootNode(child, options);
      childBlocks.push(...nested);
    }
  }

  const payload: Record<string, unknown> = {
    rich_text: primaryRichText,
  };
  if (isTask) {
    payload.checked = Boolean(item.checked);
  }
  if (childBlocks.length > 0) {
    payload.children = childBlocks;
  }

  return {
    object: 'block',
    type: blockType,
    [blockType]: payload,
  };
}

async function convertBlockquote(
  node: Blockquote,
  options: ObsidianToNotionOptions
): Promise<NotionBlock> {
  // Detect Obsidian Callout syntax: > [!type] optional title
  const firstChild = node.children[0];
  if (firstChild && firstChild.type === 'paragraph' && firstChild.children.length > 0) {
    const firstInline = firstChild.children[0];
    if (firstInline.type === 'text') {
      const calloutMatch = firstInline.value.match(/^\[!([a-zA-Z0-9_-]+)\]([+-])?[ \t]*(.*)$/m);
      if (calloutMatch && firstInline.value.startsWith('[!')) {
        const calloutType = calloutMatch[1].toLowerCase();
        const style = CALLOUT_STYLES[calloutType] ?? { emoji: '💡', color: 'gray_background' };
        const lines = firstInline.value.split('\n');
        const headerLine = lines[0];
        const titleMatch = headerLine.match(/^\[![a-zA-Z0-9_-]+\][+-]?[ \t]*(.*)$/);
        const titleText =
          (titleMatch?.[1]?.trim()) ||
          calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

        const bodyChildren: NotionBlock[] = [];
        const remainingFirstText = lines.slice(1).join('\n');

        // Reconstruct remaining phrasing in first paragraph (after the [!type] header line)
        const remainingInlines: PhrasingContent[] = [];
        if (remainingFirstText.length > 0) {
          remainingInlines.push({ type: 'text', value: remainingFirstText });
        }
        if (firstChild.children.length > 1) {
          remainingInlines.push(...firstChild.children.slice(1));
        }
        if (remainingInlines.length > 0) {
          const restRichText = await convertPhrasingNodes(remainingInlines, {}, options);
          if (restRichText.length > 0) {
            bodyChildren.push({
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: restRichText },
            });
          }
        }

        // Convert any additional blocks inside the callout
        for (const extraNode of node.children.slice(1)) {
          const converted = await convertRootNode(extraNode, options);
          bodyChildren.push(...converted);
        }

        const calloutPayload: Record<string, unknown> = {
          rich_text: makeTextRichText(titleText, { bold: true }),
          icon: { type: 'emoji', emoji: style.emoji },
          color: style.color,
        };
        if (bodyChildren.length > 0) {
          calloutPayload.children = bodyChildren;
        }

        return {
          object: 'block',
          type: 'callout',
          callout: calloutPayload,
        };
      }
    }
  }

  // Standard blockquote
  let quoteRichText: NotionRichText[] = [];
  const nestedChildren: NotionBlock[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (i === 0 && child.type === 'paragraph') {
      quoteRichText = await convertPhrasingNodes((child as Paragraph).children, {}, options);
    } else {
      const converted = await convertRootNode(child, options);
      nestedChildren.push(...converted);
    }
  }

  const payload: Record<string, unknown> = {
    rich_text: quoteRichText,
  };
  if (nestedChildren.length > 0) {
    payload.children = nestedChildren;
  }

  return {
    object: 'block',
    type: 'quote',
    quote: payload,
  };
}

function convertCode(node: Code): NotionBlock {
  return {
    object: 'block',
    type: 'code',
    code: {
      language: normalizeCodeLanguage(node.lang),
      rich_text: makeTextRichText(node.value),
    },
  };
}

async function convertTable(
  node: Table,
  options: ObsidianToNotionOptions
): Promise<NotionBlock> {
  const rows: TableRow[] = node.children;
  const tableWidth = rows.reduce((max, r) => Math.max(max, r.children.length), 1);

  const tableRows: NotionBlock[] = [];
  for (const row of rows) {
    const cells: NotionRichText[][] = [];
    for (let col = 0; col < tableWidth; col++) {
      const cell = row.children[col];
      if (cell) {
        cells.push(await convertPhrasingNodes(cell.children, {}, options));
      } else {
        cells.push([]);
      }
    }
    tableRows.push({
      object: 'block',
      type: 'table_row',
      table_row: { cells },
    });
  }

  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: tableWidth,
      has_column_header: true,
      has_row_header: false,
      children: tableRows,
    },
  };
}

async function convertPhrasingNodes(
  nodes: PhrasingContent[],
  annotations: NotionRichTextAnnotations,
  options: ObsidianToNotionOptions,
  linkUrl: string | null = null
): Promise<NotionRichText[]> {
  const result: NotionRichText[] = [];
  for (const node of nodes) {
    const items = await convertPhrasingNode(node, annotations, linkUrl, options);
    result.push(...items);
  }
  return result;
}

async function convertPhrasingNode(
  node: PhrasingContent,
  annotations: NotionRichTextAnnotations,
  linkUrl: string | null,
  options: ObsidianToNotionOptions
): Promise<NotionRichText[]> {
  switch (node.type) {
    case 'text':
      return await parseObsidianInlineText(node.value, annotations, linkUrl, options);
    case 'strong':
      return await convertPhrasingNodes(
        node.children,
        { ...annotations, bold: true },
        options,
        linkUrl
      );
    case 'emphasis':
      return await convertPhrasingNodes(
        node.children,
        { ...annotations, italic: true },
        options,
        linkUrl
      );
    case 'delete':
      return await convertPhrasingNodes(
        node.children,
        { ...annotations, strikethrough: true },
        options,
        linkUrl
      );
    case 'inlineCode':
      return makeTextRichText(node.value, { ...annotations, code: true }, linkUrl);
    case 'link': {
      const linkNode = node as Link;
      const validHref = /^https?:\/\/|^mailto:/i.test(linkNode.url) ? linkNode.url : null;
      return await convertPhrasingNodes(linkNode.children, annotations, options, validHref);
    }
    case 'break':
      return makeTextRichText('\n', annotations, linkUrl);
    default: {
      const anyNode = node as unknown as { type: string; value?: string };
      if (anyNode.type === 'inlineMath' && typeof anyNode.value === 'string') {
        return [
          {
            type: 'equation',
            equation: { expression: anyNode.value.trim() },
            ...(Object.keys(annotations).length > 0 ? { annotations: { ...annotations } } : {}),
          },
        ];
      }
      if (anyNode.type === 'html' && typeof anyNode.value === 'string') {
        if (anyNode.value.toLowerCase() === '<br>' || anyNode.value.toLowerCase() === '<br/>') {
          return makeTextRichText('\n', annotations, linkUrl);
        }
        return [];
      }
      return [];
    }
  }
}

/**
 * Parses Obsidian inline extensions inside plain text nodes:
 * - `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`
 * - `==highlighted text==`
 */
async function parseObsidianInlineText(
  text: string,
  annotations: NotionRichTextAnnotations,
  linkUrl: string | null,
  options: ObsidianToNotionOptions
): Promise<NotionRichText[]> {
  const results: NotionRichText[] = [];
  // Combined regex matching either [[wikilink]] or ==highlight==
  const tokenRegex = /\[\[([^\]]+?)\]\]|==([^=\n]+?)==/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      results.push(...makeTextRichText(text.slice(lastIndex, match.index), annotations, linkUrl));
    }

    if (match[1] !== undefined) {
      // Wikilink
      const inner = match[1];
      const pipeIdx = inner.indexOf('|');
      const rawTarget = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
      const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;
      const hashIdx = rawTarget.indexOf('#');
      const noteTarget = (hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget).trim();
      const displayLabel = alias || rawTarget;

      const pageId = noteTarget && options.resolvePageId
        ? await options.resolvePageId(noteTarget)
        : null;

      if (pageId) {
        results.push({
          type: 'mention',
          mention: {
            type: 'page',
            page: { id: pageId },
          },
          ...(Object.keys(annotations).length > 0 ? { annotations: { ...annotations } } : {}),
        });
      } else {
        results.push(
          ...makeTextRichText(displayLabel, { ...annotations, underline: true }, linkUrl)
        );
      }
    } else if (match[2] !== undefined) {
      // Highlight ==text==
      results.push(
        ...makeTextRichText(
          match[2],
          { ...annotations, color: 'yellow_background' },
          linkUrl
        )
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    results.push(...makeTextRichText(text.slice(lastIndex), annotations, linkUrl));
  }

  return results;
}
