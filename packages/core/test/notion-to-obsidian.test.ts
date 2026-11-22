import { describe, expect, it } from 'vitest';
import { notionBlocksToObsidianMarkdown } from '../src/markdown/notion-to-obsidian.js';
import { obsidianMarkdownToNotionBlocks } from '../src/markdown/obsidian-to-notion.js';
import { NotionBlockWithChildren } from '../src/notion/client.js';

function attachNestedChildren(blocks: Array<Record<string, unknown>>): NotionBlockWithChildren[] {
  return blocks.map((block) => {
    const type = block.type as string;
    const payload = block[type] as Record<string, unknown> | undefined;
    const copy: NotionBlockWithChildren = { ...(block as NotionBlockWithChildren) };
    if (payload && Array.isArray(payload.children)) {
      copy.children = attachNestedChildren(payload.children as Array<Record<string, unknown>>);
    }
    return copy;
  });
}

describe('notionBlocksToObsidianMarkdown', () => {
  it('round-trips frontmatter, headings, callouts, todos, code, math, and tables', async () => {
    const source = [
      '---',
      'title: Demo Note',
      'tags:',
      '  - obsidian',
      '---',
      '',
      '# Project Overview',
      '',
      'Here is **bold**, ==highlight==, and $a^2 + b^2 = c^2$.',
      '',
      '> [!tip] Pro Tip',
      '> Keep backups automated.',
      '',
      '- [x] Build core engine',
      '- [ ] Ship plugin',
      '',
      '```typescript',
      'export const ok = true;',
      '```',
      '',
      '$$',
      '\\sum_{i=1}^n i',
      '$$',
      '',
      '| Col A | Col B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');

    const { blocks } = await obsidianMarkdownToNotionBlocks(source, { includeFrontmatter: true });
    const tree = attachNestedChildren(blocks);
    const restored = await notionBlocksToObsidianMarkdown(tree);

    expect(restored).toContain('---\ntitle: Demo Note');
    expect(restored).toContain('# Project Overview');
    expect(restored).toContain('**bold**');
    expect(restored).toContain('==highlight==');
    expect(restored).toContain('$a^2 + b^2 = c^2$');
    expect(restored).toContain('> [!tip] Pro Tip');
    expect(restored).toContain('> Keep backups automated.');
    expect(restored).toContain('- [x] Build core engine');
    expect(restored).toContain('- [ ] Ship plugin');
    expect(restored).toContain('```typescript\nexport const ok = true;\n```');
    expect(restored).toContain('$$\n\\sum_{i=1}^n i\n$$');
    expect(restored).toContain('| Col A | Col B |');
    expect(restored).toContain('| 1 | 2 |');
  });

  it('downloads hosted image blocks into local attachments', async () => {
    const blocks: NotionBlockWithChildren[] = [
      {
        object: 'block',
        type: 'image',
        image: {
          type: 'file',
          file: { url: 'https://prod-files-secure.s3.amazonaws.com/abc/photo.png?sig=123' },
        },
      },
    ];

    const md = await notionBlocksToObsidianMarkdown(blocks, {
      downloadAttachment: async (_url, filename) => `attachments/${filename}`,
    });

    expect(md.trim()).toBe('![[attachments/photo.png]]');
  });
});
