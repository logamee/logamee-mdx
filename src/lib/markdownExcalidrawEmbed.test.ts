import { describe, expect, it } from 'vitest';
import { isLocalMarkdownExcalidrawEmbedSource } from './markdownExcalidrawEmbed';

const nestedWorkspaceContext = {
  currentFilePath: '/workspace/docs/guide.md',
  workspaceRoot: '/workspace',
};

describe('Markdown Excalidraw embed sources', () => {
  it('accepts local scene paths that remain inside the workspace', () => {
    expect(isLocalMarkdownExcalidrawEmbedSource(
      '../diagrams/system%20design.excalidraw',
      nestedWorkspaceContext,
    )).toBe(true);
    expect(isLocalMarkdownExcalidrawEmbedSource(
      'local.excalidraw',
      nestedWorkspaceContext,
    )).toBe(true);
  });

  it('rejects remote, malformed, and escaping scene paths', () => {
    for (const source of [
      'https://example.com/system.excalidraw',
      '../../outside.excalidraw',
      '%2e%2e/diagrams/system.excalidraw',
      'diagram.excalidraw?theme=dark',
      'diagram%2fhidden.excalidraw',
      'diagram.json',
    ]) {
      expect(isLocalMarkdownExcalidrawEmbedSource(source, nestedWorkspaceContext)).toBe(false);
    }
  });
});
