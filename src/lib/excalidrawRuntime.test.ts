// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportExcalidrawSceneAssets,
  exportExcalidrawSceneSvg,
} from './excalidrawRuntime';

const excalidrawMocks = vi.hoisted(() => ({
  exportToBlob: vi.fn<(options: unknown) => Promise<Blob>>(),
  exportToSvg: vi.fn<(options: unknown) => Promise<SVGSVGElement>>(),
  getNonDeletedElements: vi.fn<(elements: unknown[]) => unknown[]>(),
  restore: vi.fn<(...args: unknown[]) => {
    appState: Record<string, unknown>;
    elements: unknown[];
    files: Record<string, unknown>;
  }>(),
}));

vi.mock('@excalidraw/excalidraw', () => ({
  FONT_FAMILY: { Excalifont: 5 },
  exportToBlob: excalidrawMocks.exportToBlob,
  exportToSvg: excalidrawMocks.exportToSvg,
  getNonDeletedElements: excalidrawMocks.getNonDeletedElements,
  restore: excalidrawMocks.restore,
}));

const SCENE = JSON.stringify({
  appState: {},
  elements: [{ id: 'shape-1', isDeleted: false, type: 'rectangle' }],
  files: {},
  source: 'mmd',
  type: 'excalidraw',
  version: 2,
});

describe('excalidrawRuntime exports', () => {
  beforeEach(() => {
    excalidrawMocks.exportToBlob.mockReset();
    excalidrawMocks.exportToSvg.mockReset();
    excalidrawMocks.getNonDeletedElements.mockReset();
    excalidrawMocks.restore.mockReset();
    excalidrawMocks.restore.mockReturnValue({
      appState: { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' },
      elements: [{ id: 'shape-1', isDeleted: false, type: 'rectangle' }],
      files: {},
    });
    excalidrawMocks.getNonDeletedElements.mockReturnValue([
      { id: 'shape-1', isDeleted: false, type: 'rectangle' },
    ]);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '320');
    svg.setAttribute('height', '180');
    excalidrawMocks.exportToSvg.mockResolvedValue(svg);
    excalidrawMocks.exportToBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  });

  it('keeps the existing SVG-only export contract', async () => {
    await expect(exportExcalidrawSceneSvg(SCENE, 'light')).resolves.toBeInstanceOf(SVGSVGElement);

    expect(excalidrawMocks.exportToSvg).toHaveBeenCalledWith(expect.objectContaining({
      appState: expect.objectContaining({
        exportBackground: false,
        exportEmbedScene: false,
        exportWithDarkMode: false,
        viewBackgroundColor: 'transparent',
      }),
      renderEmbeddables: false,
      reuseImages: true,
    }));
  });

  it('exports linked SVG and PNG assets from one restored scene', async () => {
    const assets = await exportExcalidrawSceneAssets(SCENE, 'dark', 3);

    expect(assets.svgText).toContain('<svg');
    expect(assets.pngBlob.type).toBe('image/png');
    expect(assets.width).toBe(320);
    expect(assets.height).toBe(180);
    expect(excalidrawMocks.restore).toHaveBeenCalledTimes(1);
    expect(excalidrawMocks.exportToSvg).toHaveBeenCalledOnce();
    expect(excalidrawMocks.exportToBlob).toHaveBeenCalledWith(expect.objectContaining({
      appState: expect.objectContaining({
        exportBackground: false,
        exportEmbedScene: false,
        exportWithDarkMode: true,
        viewBackgroundColor: 'transparent',
      }),
      getDimensions: expect.any(Function),
      mimeType: 'image/png',
      quality: 1,
    }));
    const pngOptions = excalidrawMocks.exportToBlob.mock.calls[0]?.[0] as {
      getDimensions: (width: number, height: number) => unknown;
    };
    expect(pngOptions.getDimensions(100, 50)).toEqual({ height: 150, scale: 3, width: 300 });
  });

  it('rejects unsupported PNG scales before rendering', async () => {
    await expect(exportExcalidrawSceneAssets(SCENE, 'light', 4)).rejects.toThrow(
      'Excalidraw PNG scale must be 1, 2, or 3',
    );

    expect(excalidrawMocks.restore).not.toHaveBeenCalled();
    expect(excalidrawMocks.exportToBlob).not.toHaveBeenCalled();
  });
});
