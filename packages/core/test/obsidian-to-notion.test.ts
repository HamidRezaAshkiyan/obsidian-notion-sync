import { describe, expect, it, vi } from 'vitest';
import {
  FRONTMATTER_TOGGLE_MARKER,
  normalizeCodeLanguage,
  obsidianMarkdownToNotionBlocks,
} from '../src/markdown/obsidian-to-notion.js';
import { NotionRichText } from '../src/types.js';

describe('obsidianMarkdownToNotionBlocks', () => {
  it('converts headings, rich text, highlights, inline math, and links', async () => {
    const md = [
      '# Title',
      '## Subtitle',
      '#### Deep Heading',
      '',
      'Hello **bold**, *italic*, ~~strike~~, `code`, ==highlighted==, $E=mc^2$, and [Notion](https://notion.so).',
    ].join('\n');

    const { blocks } = await obsidianMarkdownToNotionBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading_1', 'heading_2', 'heading_3', 'paragraph']);

    // H4 maps to bold heading_3
    const h3 = blocks[2].heading_3 as { rich_text: NotionRichText[] };
    expect(h3.rich_text[0].annotations?.bold).toBe(true);

    const para = blocks[3].paragraph as { rich_text: NotionRichText[] };
    expect(para.rich_text.some((rt) => rt.annotations?.bold && rt.text?.content === 'bold')).toBe(true);
    expect(para.rich_text.some((rt) => rt.annotations?.italic && rt.text?.content === 'italic')).toBe(true);
    expect(para.rich_text.some((rt) => rt.annotations?.strikethrough && rt.text?.content === 'strike')).toBe(true);
    expect(para.rich_text.some((rt) => rt.annotations?.code && rt.text?.content === 'code')).toBe(true);
    expect(
      para.rich_text.some(
        (rt) => rt.annotations?.color === 'yellow_background' && rt.text?.content === 'highlighted'
      )
    ).toBe(true);
    expect(para.rich_text.some((rt) => rt.type === 'equation' && rt.equation?.expression === 'E=mc^2')).toBe(true);
    expect(
      para.rich_text.some((rt) => rt.text?.link?.url === 'https://notion.so' && rt.text?.content === 'Notion')
    ).toBe(true);
  });

  it('converts Obsidian callouts into styled Notion callout blocks', async () => {
    const md = [
      '> [!warning] Be Careful',
      '> First line of callout.',
      '>',
      '> Second paragraph inside callout.',
    ].join('\n');

    const { blocks } = await obsidianMarkdownToNotionBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('callout');

    const callout = blocks[0].callout as {
      rich_text: NotionRichText[];
      icon: { emoji: string };
      color: string;
      children: Array<{ type: string }>;
    };
    expect(callout.icon.emoji).toBe('⚠️');
    expect(callout.color).toBe('yellow_background');
    expect(callout.rich_text[0].text?.content).toBe('Be Careful');
    expect(callout.children).toHaveLength(2);
  });

  it('converts task lists, nested lists, code blocks, math blocks, and GFM tables', async () => {
    const md = [
      '- [ ] Unchecked task',
      '- [x] Checked task',
      '  - Nested bullet',
      '',
      '```ts',
      'const x: number = 42;',
      '```',
      '',
      '$$',
      '\\int_0^1 x^2 dx',
      '$$',
      '',
      '| Name | Score |',
      '| --- | --- |',
      '| Alice | 100 |',
    ].join('\n');

    const { blocks } = await obsidianMarkdownToNotionBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['to_do', 'to_do', 'code', 'equation', 'table']);

    const todo1 = blocks[0].to_do as { checked: boolean };
    const todo2 = blocks[1].to_do as { checked: boolean; children: Array<{ type: string }> };
    expect(todo1.checked).toBe(false);
    expect(todo2.checked).toBe(true);
    expect(todo2.children[0].type).toBe('bulleted_list_item');

    const code = blocks[2].code as { language: string };
    expect(code.language).toBe('typescript');
    expect(normalizeCodeLanguage('py')).toBe('python');
    expect(normalizeCodeLanguage('nonexistent-lang')).toBe('plain text');

    const eq = blocks[3].equation as { expression: string };
    expect(eq.expression).toBe('\\int_0^1 x^2 dx');

    const table = blocks[4].table as { table_width: number; children: Array<{ type: string }> };
    expect(table.table_width).toBe(2);
    expect(table.children).toHaveLength(2);
  });

  it('resolves synced wikilinks to page mentions and uploads embedded local files', async () => {
    const uploadAttachment = vi.fn(async (target: string) => {
      if (target === 'diagram.png') {
        return { fileUploadId: 'fu-img-1', filename: 'diagram.png', mediaType: 'image' as const };
      }
      if (target === 'report.pdf') {
        return { fileUploadId: 'fu-pdf-1', filename: 'report.pdf', mediaType: 'pdf' as const };
      }
      return null;
    });

    const md = [
      'See [[Synced Note]] and [[Missing Note|Custom Alias]].',
      '',
      '![[diagram.png|400]]',
      '![[report.pdf]]',
    ].join('\n');

    const { blocks, referencedAttachments } = await obsidianMarkdownToNotionBlocks(md, {
      resolvePageId: (target) => (target === 'Synced Note' ? '11111111-1111-1111-1111-111111111111' : null),
      uploadAttachment,
    });

    expect(referencedAttachments).toEqual(['diagram.png', 'report.pdf']);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);

    const para = blocks[0].paragraph as { rich_text: NotionRichText[] };
    expect(
      para.rich_text.some(
        (rt) => rt.type === 'mention' && rt.mention?.page.id === '11111111-1111-1111-1111-111111111111'
      )
    ).toBe(true);
    expect(
      para.rich_text.some((rt) => rt.type === 'text' && rt.text?.content === 'Custom Alias')
    ).toBe(true);

    expect(blocks[1].type).toBe('image');
    expect((blocks[1].image as { file_upload: { id: string } }).file_upload.id).toBe('fu-img-1');
    expect(blocks[2].type).toBe('pdf');
    expect((blocks[2].pdf as { file_upload: { id: string } }).file_upload.id).toBe('fu-pdf-1');
  });

  it('preserves YAML frontmatter only when includeFrontmatter is true and chunks >2000 char text', async () => {
    const longText = 'a'.repeat(4500);
    const md = `---\ntags: [work, spec]\n---\n\n${longText}`;

    const backupConverted = await obsidianMarkdownToNotionBlocks(md, { includeFrontmatter: true });
    expect(backupConverted.blocks[0].type).toBe('toggle');
    const toggle = backupConverted.blocks[0].toggle as { rich_text: NotionRichText[] };
    expect(toggle.rich_text[0].text?.content).toBe(FRONTMATTER_TOGGLE_MARKER);

    const shareConverted = await obsidianMarkdownToNotionBlocks(md, { includeFrontmatter: false });
    expect(shareConverted.blocks[0].type).toBe('paragraph');
    const para = shareConverted.blocks[0].paragraph as { rich_text: NotionRichText[] };
    expect(para.rich_text).toHaveLength(3); // 2000 + 2000 + 500
    expect(para.rich_text.every((rt) => (rt.text?.content.length ?? 0) <= 2000)).toBe(true);
  });
});
