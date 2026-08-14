import { describe, expect, it } from 'vitest';
import {
  EXCALIDRAW_FONT_FAMILY,
  createEmptyExcalidrawScene,
  parseExcalidrawScene,
} from './excalidrawScene';

interface MutableScene {
  appState: Record<string, unknown>;
  elements: Record<string, unknown>[];
  files: Record<string, unknown>;
  source: string;
  type: string;
  version: number;
}

function sceneWithBindings(): MutableScene {
  return {
    appState: {
      currentItemFontFamily: 5,
      viewBackgroundColor: 'transparent',
    },
    elements: [
      {
        boundElements: [
          { id: 'label', type: 'text' },
          { id: 'connector', type: 'arrow' },
        ],
        id: 'source',
        type: 'rectangle',
      },
      {
        containerId: 'source',
        fontFamily: 5,
        id: 'label',
        type: 'text',
      },
      {
        boundElements: [{ id: 'connector', type: 'arrow' }],
        id: 'target',
        type: 'ellipse',
      },
      {
        endBinding: { elementId: 'target', focus: 0, gap: 8 },
        id: 'connector',
        points: [[0, 0], [180, 0]],
        startBinding: { elementId: 'source', focus: 0, gap: 8 },
        type: 'arrow',
      },
    ],
    files: {
      'image-1': { id: 'image-1', dataURL: 'data:image/png;base64,AA==', mimeType: 'image/png' },
    },
    source: 'mmd',
    type: 'excalidraw',
    version: 2,
  };
}

describe('Excalidraw v2 scenes', () => {
  it('creates a transparent scene with Excalidraw Chinese text defaults', () => {
    expect(createEmptyExcalidrawScene()).toEqual({
      appState: {
        currentItemFontFamily: EXCALIDRAW_FONT_FAMILY,
        currentItemRoughness: 1,
        viewBackgroundColor: 'transparent',
      },
      elements: [],
      files: {},
      source: 'mmd',
      type: 'excalidraw',
      version: 2,
    });
    expect(EXCALIDRAW_FONT_FAMILY).toBe(5);
  });

  it('preserves standard scene elements, appState, and files', () => {
    const scene = sceneWithBindings();

    expect(parseExcalidrawScene(JSON.stringify(scene))).toEqual(scene);
  });

  it.each([
    ['a private label field', (scene: MutableScene) => {
      scene.elements[0] = { ...scene.elements[0], label: 'not-standard' };
    }],
    ['a one-way text binding', (scene: MutableScene) => {
      scene.elements[0] = { ...scene.elements[0], boundElements: [{ id: 'connector', type: 'arrow' }] };
    }],
    ['an arrow missing an endpoint registration', (scene: MutableScene) => {
      scene.elements[2] = { ...scene.elements[2], boundElements: [] };
    }],
    ['overlapping arrow points', (scene: MutableScene) => {
      scene.elements[3] = { ...scene.elements[3], points: [[0, 0], [0, 0]] };
    }],
    ['a connector with an overlapping point before a real segment', (scene: MutableScene) => {
      scene.elements[3] = { ...scene.elements[3], points: [[0, 0], [0, 0], [180, 0]] };
    }],
    ['duplicate element IDs', (scene: MutableScene) => {
      scene.elements[2] = { ...scene.elements[2], id: 'source' };
    }],
  ])('rejects %s', (_label, mutate) => {
    const scene = sceneWithBindings();
    mutate(scene);

    expect(() => parseExcalidrawScene(JSON.stringify(scene))).toThrow('Invalid Excalidraw scene');
  });
});
