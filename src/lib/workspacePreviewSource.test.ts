import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMarkdownImagePreviewUrl, getWorkspacePreviewUrl, resetImagePreviewCache } from './workspacePreviewSource';

const convertFileSrcMock = vi.hoisted(() => vi.fn<(path: string) => string>());
const invokeMock = vi.hoisted(() => vi.fn<(command: string, payload?: unknown) => Promise<string>>());

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: convertFileSrcMock,
  invoke: invokeMock,
}));

describe('workspace preview sources', () => {
  beforeEach(() => {
    resetImagePreviewCache();
    convertFileSrcMock.mockImplementation((path) => `asset://localhost/${encodeURIComponent(path)}`);
    invokeMock.mockReset();
  });

  it('converts media paths to scoped asset URLs', () => {
    expect(getWorkspacePreviewUrl('/workspace/media/clip.mp4')).toBe('asset://localhost/%2Fworkspace%2Fmedia%2Fclip.mp4');
    expect(convertFileSrcMock).toHaveBeenCalledWith('/workspace/media/clip.mp4');
  });

  it('adds a safe preview revision without corrupting an existing asset URL query or fragment', () => {
    convertFileSrcMock.mockReturnValueOnce('asset://localhost/%2Fworkspace%2Fmedia%2Fclip.mp4?token=allowed#preview');

    expect(getWorkspacePreviewUrl('/workspace/media/clip.mp4', 7)).toBe(
      'asset://localhost/%2Fworkspace%2Fmedia%2Fclip.mp4?token=allowed&mmdRevision=7#preview',
    );
    expect(() => getWorkspacePreviewUrl('/workspace/media/clip.mp4', -1)).toThrow(RangeError);
    expect(() => getWorkspacePreviewUrl('/workspace/media/clip.mp4', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('deduplicates authorized Markdown image resolution and returns an asset URL', async () => {
    invokeMock.mockResolvedValue('/workspace/assets/cover.png');

    const input = {
      currentFilePath: '/workspace/readme.md',
      imageSrc: 'assets/cover.png',
      workspaceRoot: '/workspace',
    };
    const [first, second] = await Promise.all([
      getMarkdownImagePreviewUrl(input),
      getMarkdownImagePreviewUrl(input),
    ]);

    expect(first).toBe('asset://localhost/%2Fworkspace%2Fassets%2Fcover.png');
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('resolve_markdown_image', input);
  });
});
