// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import { parseExcalidrawScene } from './excalidrawScene';

let excalidrawApi: typeof import('@excalidraw/excalidraw');

const STANDARD_V2_SCENE = {
  appState: {
    currentItemFontFamily: 5,
    viewBackgroundColor: 'transparent',
  },
  elements: [
    {
      backgroundColor: 'transparent',
      boundElements: [
        { id: 'label', type: 'text' },
        { id: 'connector', type: 'arrow' },
      ],
      height: 96,
      id: 'source',
      type: 'rectangle',
      width: 180,
      x: 0,
      y: 0,
    },
    {
      autoResize: true,
      backgroundColor: 'transparent',
      containerId: 'source',
      fontFamily: 5,
      fontSize: 20,
      height: 24,
      id: 'label',
      originalText: '中文标签',
      text: '中文标签',
      textAlign: 'center',
      type: 'text',
      verticalAlign: 'middle',
      width: 80,
      x: 50,
      y: 36,
    },
    {
      backgroundColor: 'transparent',
      boundElements: [{ id: 'connector', type: 'arrow' }],
      height: 96,
      id: 'target',
      type: 'ellipse',
      width: 140,
      x: 360,
      y: 0,
    },
    {
      endBinding: { elementId: 'target', focus: 0, gap: 8 },
      endArrowhead: 'arrow',
      height: 0,
      id: 'connector',
      points: [[0, 0], [180, 0]],
      startArrowhead: null,
      startBinding: { elementId: 'source', focus: 0, gap: 8 },
      type: 'arrow',
      width: 180,
      x: 180,
      y: 48,
    },
    {
      fileId: 'image-1',
      height: 64,
      id: 'image',
      scale: [1, 1],
      status: 'saved',
      type: 'image',
      width: 64,
      x: 540,
      y: 0,
    },
  ],
  files: {
    'image-1': {
      created: 1,
      dataURL: 'data:image/png;base64,AA==',
      id: 'image-1',
      mimeType: 'image/png',
    },
  },
  source: 'mmd',
  type: 'excalidraw',
  version: 2,
};

describe('pinned Excalidraw scene compatibility', () => {
  beforeAll(async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ filter: '' }),
    });
    excalidrawApi = await import('@excalidraw/excalidraw');
  }, 30_000);

  it('round-trips v2 scenes through the pinned public API without losing bindings or files', () => {
    const restored = excalidrawApi.restore(STANDARD_V2_SCENE as never, null, null, {
      repairBindings: true,
    });
    const serialized = excalidrawApi.serializeAsJSON(
      restored.elements,
      restored.appState,
      restored.files,
      'local',
    );
    const parsed = parseExcalidrawScene(serialized);
    const elementsById = new Map(parsed.elements.map((element) => [element.id, element]));
    const source = elementsById.get('source');
    const target = elementsById.get('target');
    const label = elementsById.get('label');
    const connector = elementsById.get('connector');

    expect(excalidrawApi.FONT_FAMILY.Excalifont).toBe(5);
    expect(parsed.version).toBe(2);
    expect(restored.appState.currentItemFontFamily).toBe(5);
    expect(parsed.appState.viewBackgroundColor).toBe('transparent');
    expect(parsed.files).toHaveProperty('image-1');
    expect(source?.boundElements).toEqual(expect.arrayContaining([
      { id: 'label', type: 'text' },
      { id: 'connector', type: 'arrow' },
    ]));
    expect(target?.boundElements).toEqual(expect.arrayContaining([{ id: 'connector', type: 'arrow' }]));
    expect(label?.containerId).toBe('source');
    expect(connector?.startBinding).toMatchObject({ elementId: 'source' });
    expect(connector?.endBinding).toMatchObject({ elementId: 'target' });
    expect(connector?.points).not.toEqual([[0, 0], [0, 0]]);
  });
});
