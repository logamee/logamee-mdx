// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAndSyncExcalidrawAssetPair } from './excalidrawAssetSync';

const mocks = vi.hoisted(() => ({
  exportExcalidrawSceneAssets: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readMarkdownExcalidraw: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeExcalidrawAssetPair: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('./excalidrawRuntime', () => ({
  exportExcalidrawSceneAssets: mocks.exportExcalidrawSceneAssets,
}));
vi.mock('./tauriCommands', () => ({
  readMarkdownExcalidraw: mocks.readMarkdownExcalidraw,
  writeExcalidrawAssetPair: mocks.writeExcalidrawAssetPair,
}));

describe('Excalidraw asset synchronization', () => {
  beforeEach(() => {
    mocks.exportExcalidrawSceneAssets.mockReset();
    mocks.readMarkdownExcalidraw.mockReset();
    mocks.writeExcalidrawAssetPair.mockReset();
  });

  it('reads one source scene, exports both sidecars, and creates a linked reference', async () => {
    mocks.readMarkdownExcalidraw.mockResolvedValue('{"type":"excalidraw","version":2}');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '320');
    svg.setAttribute('height', '180');
    mocks.exportExcalidrawSceneAssets.mockResolvedValue({
      height: 180,
      pngBlob: new Blob(['png'], { type: 'image/png' }),
      svg,
      svgText: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width: 320,
    });
    mocks.writeExcalidrawAssetPair.mockResolvedValue({
      pngFileName: 'system.png',
      pngMarkdownPath: '../assets/excalidraw-assets/system.png',
      sourceSha256: 'a'.repeat(64),
      svgFileName: 'system.svg',
      svgMarkdownPath: '../assets/excalidraw-assets/system.svg',
      updated: true,
    });

    const result = await renderAndSyncExcalidrawAssetPair({
      appearance: 'dark',
      document: { relative_path: 'docs/guide.md' },
      documentPath: '/workspace/docs/guide.md',
      name: 'System diagram',
      resourceDirectory: 'assets',
      scale: 3,
      sourceRelativePath: 'diagrams/system.excalidraw',
      workspaceRoot: '/workspace',
      workspaceToken: 'workspace-token',
    });

    expect(mocks.readMarkdownExcalidraw).toHaveBeenCalledWith(
      '/workspace/docs/guide.md',
      '../diagrams/system.excalidraw',
      '/workspace',
    );
    expect(mocks.exportExcalidrawSceneAssets).toHaveBeenCalledWith(
      '{"type":"excalidraw","version":2}',
      'dark',
      3,
    );
    expect(mocks.writeExcalidrawAssetPair).toHaveBeenCalledWith(expect.objectContaining({
      sourceRelativePath: 'diagrams/system.excalidraw',
      resourceDirectory: 'assets',
      svgBase64: expect.any(String),
      pngBase64: expect.any(String),
    }));
    expect(result.markdown).toContain('mmd:source');
    expect(result.markdown).toContain('system.svg');
  });

  it('does not write when source reading fails', async () => {
    mocks.readMarkdownExcalidraw.mockRejectedValue(new Error('source unavailable'));

    await expect(renderAndSyncExcalidrawAssetPair({
      appearance: 'light',
      document: { relative_path: 'guide.md' },
      documentPath: '/workspace/guide.md',
      name: 'Diagram',
      resourceDirectory: 'assets',
      sourceRelativePath: 'diagram.excalidraw',
      workspaceRoot: '/workspace',
      workspaceToken: 'workspace-token',
    })).rejects.toThrow('source unavailable');
    expect(mocks.writeExcalidrawAssetPair).not.toHaveBeenCalled();
  });
});
