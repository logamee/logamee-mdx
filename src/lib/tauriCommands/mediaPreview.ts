import { invoke } from '@tauri-apps/api/core';

// 媒体/HTML 预览租约命令。

export interface MediaPreviewHandle {
  url: string;
  ownerId: number;
}

export function prepareWorkspaceMediaPreview(path: string): Promise<MediaPreviewHandle> {
  return invoke<MediaPreviewHandle>('prepare_workspace_media_preview', { path });
}

export function prepareMarkdownMediaPreview(
  currentFilePath: string,
  mediaSrc: string,
  workspaceRoot: string | null,
): Promise<MediaPreviewHandle> {
  return invoke<MediaPreviewHandle>('prepare_markdown_media_preview', {
    currentFilePath,
    mediaSrc,
    workspaceRoot,
  });
}

export function releaseMediaPreview(ownerId: number): Promise<void> {
  return invoke<void>('release_media_preview', { ownerId });
}

export function resolveWorkspaceMedia(path: string): Promise<string> {
  return invoke<string>('resolve_workspace_media', { path });
}

export function prepareHtmlPreview(path: string, content: string): Promise<string> {
  return invoke<string>('prepare_html_preview', { path, content });
}

export interface MarkdownHtmlEmbedLease {
  url: string;
  ownerId: number;
}

export function prepareMarkdownHtmlEmbed(
  markdownPath: string,
  htmlSrc: string,
  workspaceRoot: string | null,
): Promise<MarkdownHtmlEmbedLease> {
  return invoke<MarkdownHtmlEmbedLease>('prepare_markdown_html_embed', {
    markdownPath,
    htmlSrc,
    workspaceRoot,
  });
}

export function releaseMarkdownHtmlEmbed(ownerId: number): Promise<void> {
  return invoke<void>('release_markdown_html_embed', { ownerId });
}
