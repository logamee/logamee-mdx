import { convertFileSrc, invoke } from '@tauri-apps/api/core';

interface MarkdownImagePreviewInput {
  currentFilePath: string;
  imageSrc: string;
  workspaceRoot: string | null;
}

const MAX_IMAGE_PREVIEW_CACHE_ENTRIES = 128;
const imagePreviewCache = new Map<string, Promise<string>>();

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
