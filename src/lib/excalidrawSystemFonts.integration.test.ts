// @vitest-environment jsdom

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { parseExcalidrawScene } from './excalidrawScene';
import { installExcalidrawSystemFonts } from './excalidrawSystemFonts';

const constructedFontFaces: FakeFontFace[] = [];

class FakeFontFace {
  readonly family: string;
  readonly source: string | BufferSource;
  readonly unicodeRange: string;

  constructor(
    family: string,
    source: string | BufferSource,
    descriptors: FontFaceDescriptors = {},
  ) {
    this.family = family;
    this.source = source;
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    constructedFontFaces.push(this);
  }
}

function fakeCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // Pixel rendering is outside this test; SVG assertions cover exported content.
  const target: Record<PropertyKey, unknown> = {
    canvas,
    font: '',
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: (text: string) => ({ width: text.length * 10 }),
  };

  return new Proxy(target, {
    get(context, property, receiver) {
      if (Reflect.has(context, property)) return Reflect.get(context, property, receiver);
      return () => undefined;
    },
    set(context, property, value, receiver) {
      return Reflect.set(context, property, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  constructedFontFaces.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps export and scene editing usable when every local system font load rejects', async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    unhandledRejections.push(event.reason);
    event.preventDefault();
  };
  const fetchSpy = vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected fetch')));
  const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('FontFace', FakeFontFace);
  const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  onTestFinished(() => {
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (originalFonts) {
      Object.defineProperty(document, 'fonts', originalFonts);
    } else {
      Reflect.deleteProperty(document, 'fonts');
    }
  });
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  installExcalidrawSystemFonts();
  const fontSetLoad = vi.fn<() => Promise<never>>(() => (
    Promise.reject(new Error('Unexpected CSS font request'))
  ));
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: vi.fn<() => void>(),
      check: vi.fn<() => boolean>(() => false),
      has: vi.fn<() => boolean>(() => false),
      load: fontSetLoad,
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(
    this: HTMLCanvasElement,
  ) {
    return fakeCanvasContext(this);
  });

  const {
    convertToExcalidrawElements,
    exportToCanvas,
    exportToSvg,
    restore,
    serializeAsJSON,
  } = await import('@excalidraw/excalidraw');
  const elements = convertToExcalidrawElements([
    { type: 'text', x: 0, y: 0, text: 'Hello', fontFamily: 5 },
    { type: 'text', x: 0, y: 40, text: '你好', fontFamily: 5 },
  ]);
  const fontFamiliesBefore = elements.map((element) => element.type === 'text' && element.fontFamily);
  const exportOptions = {
    appState: {
      exportBackground: false,
      viewBackgroundColor: '#ffffff',
    },
    elements,
    files: null,
  };
  const canvas = await exportToCanvas(exportOptions);
  const svg = await exportToSvg(exportOptions);

  const representativeScene = {
    appState: { currentItemFontFamily: 5, viewBackgroundColor: '#ffffff' },
    elements: [
      {
        fontFamily: 5,
        fontSize: 20,
        height: 25,
        id: 'editable-label',
        originalText: 'Original 文本',
        text: 'Original 文本',
        type: 'text',
        width: 140,
        x: 24,
        y: 36,
      },
      {
        height: 80,
        id: 'geometry',
        type: 'rectangle',
        width: 160,
        x: 220,
        y: 40,
      },
    ],
    files: {},
    source: 'mmd',
    type: 'excalidraw',
    version: 2,
  };
  const restored = restore(representativeScene as never, null, null);
  const editedElements = restored.elements.map((element) => (
    element.id === 'editable-label'
      ? { ...element, originalText: 'Edited 文本', text: 'Edited 文本' }
      : element
  ));
  const serialized = serializeAsJSON(
    editedElements,
    restored.appState,
    restored.files,
    'local',
  );
  const parsed = parseExcalidrawScene(serialized);
  const editedLabel = parsed.elements.find(({ id }) => id === 'editable-label');
  const geometry = parsed.elements.find(({ id }) => id === 'geometry');

  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhrOpenSpy).not.toHaveBeenCalled();
  expect(fontSetLoad).toHaveBeenCalledTimes(1);
  expect(fontSetLoad).toHaveBeenCalledWith(
    expect.stringContaining('system-ui, sans-serif'),
    'Helo你好',
  );
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringContaining('Failed to load font'),
    expect.objectContaining({ message: 'Unexpected CSS font request' }),
  );
  expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  expect(constructedFontFaces.length).toBeGreaterThan(0);
  expect(constructedFontFaces.every(({ source }) => (
    typeof source === 'string' && source.startsWith('local(') && !/url\(|https?:/iu.test(source)
  ))).toBe(true);
  expect(unhandledRejections).toEqual([]);
  expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(svg.textContent).toContain('Hello');
  expect(svg.textContent).toContain('你好');
  expect(svg.querySelector('.style-fonts')?.textContent?.trim()).toBe('');
  expect(svg.outerHTML).not.toMatch(/@font-face|https?:\/\/esm\.sh|\/fonts\//iu);
  expect(svg.outerHTML).toContain('system-ui, sans-serif');
  expect(elements.map((element) => element.type === 'text' && element.fontFamily))
    .toEqual(fontFamiliesBefore);
  expect(editedLabel).toMatchObject({
    fontFamily: 5,
    height: 25,
    originalText: 'Edited 文本',
    text: 'Edited 文本',
    width: 140,
    x: 24,
    y: 36,
  });
  expect(typeof editedLabel?.fontFamily).toBe('number');
  expect(geometry).toMatchObject({ height: 80, width: 160, x: 220, y: 40 });
}, 15_000);
