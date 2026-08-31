import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface MarkdownImagePreviewInput {
  currentFilePath: string;
  imageSrc: string;
  workspaceRoot: string | null;
}

export interface MarkdownMediaPreviewInput {
  currentFilePath: string;
  mediaSrc: string;
  workspaceRoot: string | null;
}

const MAX_IMAGE_PREVIEW_CACHE_ENTRIES = 128;
const imagePreviewCache = new Map<string, Promise<string>>();
const mediaPreviewCache = new Map<string, Promise<string>>();

export function getWorkspacePreviewUrl(path: string, previewRevision?: number): string {
  const assetUrl = convertFileSrc(path);
  if (previewRevision === undefined) return assetUrl;
  if (!Number.isSafeInteger(previewRevision) || previewRevision < 0) {
    throw new RangeError('Preview revision must be a non-negative safe integer');
  }

  const fragmentIndex = assetUrl.indexOf('#');
  const urlWithoutFragment = fragmentIndex === -1 ? assetUrl : assetUrl.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : assetUrl.slice(fragmentIndex);
  const separator = urlWithoutFragment.includes('?')
    ? urlWithoutFragment.endsWith('?') || urlWithoutFragment.endsWith('&') ? '' : '&'
    : '?';
  return `${urlWithoutFragment}${separator}mmdRevision=${previewRevision}${fragment}`;
}

export function resetImagePreviewCache(): void {
  imagePreviewCache.clear();
  mediaPreviewCache.clear();
}

export function getMarkdownImagePreviewUrl(input: MarkdownImagePreviewInput): Promise<string> {
  const cacheKey = JSON.stringify([input.currentFilePath, input.workspaceRoot, input.imageSrc]);
  const cached = imagePreviewCache.get(cacheKey);
  if (cached) return cached;

  const pending = invoke<string>('resolve_markdown_image', {
    currentFilePath: input.currentFilePath,
    imageSrc: input.imageSrc,
    workspaceRoot: input.workspaceRoot,
  })
    .then(getWorkspacePreviewUrl)
    .catch((error: unknown) => {
      imagePreviewCache.delete(cacheKey);
      throw error;
    });
  imagePreviewCache.set(cacheKey, pending);
  if (imagePreviewCache.size > MAX_IMAGE_PREVIEW_CACHE_ENTRIES) {
    const oldest = imagePreviewCache.keys().next().value;
    if (oldest !== undefined) imagePreviewCache.delete(oldest);
  }
  return pending;
}

export function getMarkdownMediaPreviewUrl(input: MarkdownMediaPreviewInput): Promise<string> {
  const cacheKey = JSON.stringify([input.currentFilePath, input.workspaceRoot, input.mediaSrc]);
  const cached = mediaPreviewCache.get(cacheKey);
  if (cached) return cached;

  const pending = invoke<string>('resolve_markdown_media', {
    currentFilePath: input.currentFilePath,
    mediaSrc: input.mediaSrc,
    workspaceRoot: input.workspaceRoot,
  })
    .then(getWorkspacePreviewUrl)
    .catch((error: unknown) => {
      mediaPreviewCache.delete(cacheKey);
      throw error;
    });
  mediaPreviewCache.set(cacheKey, pending);
  if (mediaPreviewCache.size > MAX_IMAGE_PREVIEW_CACHE_ENTRIES) {
    const oldest = mediaPreviewCache.keys().next().value;
    if (oldest !== undefined) mediaPreviewCache.delete(oldest);
  }
  return pending;
}
