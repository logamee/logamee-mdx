import { describe, expect, it } from 'vitest';
import { isLocalMarkdownHtmlEmbedSource } from './markdownHtmlEmbed';

const nestedWorkspaceContext = {
  currentFilePath: '/workspace/docs/guide.md',
  workspaceRoot: '/workspace',
};

describe('Markdown HTML embed sources', () => {
  it('accepts a parent-relative HTML file that remains inside the workspace', () => {
    expect(isLocalMarkdownHtmlEmbedSource(
      '../demos/demo%20page.html',
      nestedWorkspaceContext,
    )).toBe(true);
  });

  it('rejects parent traversal that escapes the workspace', () => {
    expect(isLocalMarkdownHtmlEmbedSource(
      '../../outside.html',
      nestedWorkspaceContext,
    )).toBe(false);
    expect(isLocalMarkdownHtmlEmbedSource(
      '%2e%2e/%2e%2e/outside.html',
      nestedWorkspaceContext,
    )).toBe(false);
  });

  it('rejects percent-encoded parent components even when they resolve inside the workspace', () => {
    expect(isLocalMarkdownHtmlEmbedSource(
      '%2e%2e/demos/demo.html',
      nestedWorkspaceContext,
    )).toBe(false);
  });

  it('handles a Windows drive root without allowing traversal above it', () => {
    const context = {
      currentFilePath: String.raw`C:\workspace\docs\guide.md`,
      workspaceRoot: String.raw`C:\workspace`,
    };
    expect(isLocalMarkdownHtmlEmbedSource('../demo.html', context)).toBe(true);
    expect(isLocalMarkdownHtmlEmbedSource('../../outside.html', context)).toBe(false);
  });
});
