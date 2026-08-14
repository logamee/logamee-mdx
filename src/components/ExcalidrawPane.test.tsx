// @vitest-environment jsdom

import { act, type ComponentProps, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExcalidrawPane } from './ExcalidrawPane';

interface ExcalidrawPropsCapture {
  aiEnabled?: boolean;
  initialData?: unknown;
  onChange?: (elements: unknown, appState: unknown, files: unknown) => void;
  UIOptions?: unknown;
  viewModeEnabled?: boolean;
  theme?: 'light' | 'dark';
}

const excalidrawMocks = vi.hoisted(() => ({
  calls: [] as ExcalidrawPropsCapture[],
  restore: vi.fn<(...args: unknown[]) => unknown>(),
  serializeAsJSON: vi.fn<(...args: unknown[]) => string>(),
  mountCount: 0,
}));

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: ExcalidrawPropsCapture) => {
    const [initialData] = useState(props.initialData);
    const [mountId] = useState(() => ++excalidrawMocks.mountCount);
    excalidrawMocks.calls.push(props);
    return <div data-initial-scene={JSON.stringify(initialData)} data-mount-id={mountId} data-testid="excalidraw-canvas" />;
  },
  FONT_FAMILY: { Excalifont: 5 },
  restore: excalidrawMocks.restore,
  serializeAsJSON: excalidrawMocks.serializeAsJSON,
}));

vi.mock('@excalidraw/excalidraw/index.css', () => ({}));

const SCENE = JSON.stringify({
  appState: {
    currentItemFontFamily: 5,
    viewBackgroundColor: 'transparent',
  },
  elements: [],
  files: {},
  source: 'mmd',
  type: 'excalidraw',
  version: 2,
});

describe('ExcalidrawPane', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    excalidrawMocks.calls.length = 0;
    excalidrawMocks.mountCount = 0;
    excalidrawMocks.restore.mockReset();
    excalidrawMocks.serializeAsJSON.mockReset();
    excalidrawMocks.restore.mockReturnValue({
      appState: {
        currentItemFontFamily: 5,
        viewBackgroundColor: 'transparent',
      },
      elements: [],
      files: {},
    });
    excalidrawMocks.serializeAsJSON.mockImplementation((elements, appState, files) => JSON.stringify({
      appState,
      elements,
      files,
      source: 'mmd',
      type: 'excalidraw',
      version: 2,
    }));
    document.documentElement.setAttribute('data-skin', 'jinxiu-zhusha');
    document.documentElement.setAttribute('data-appearance', 'light');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderPane(overrides: Partial<ComponentProps<typeof ExcalidrawPane>> = {}) {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <ExcalidrawPane
          activePath="/workspace/architecture.excalidraw"
          content={SCENE}
          documentEpoch={3}
          documentId="drawing-architecture"
          editable
          onContentChange={onContentChange}
          {...overrides}
        />,
      );
    });
    return onContentChange;
  }

  it('restores standard scene data without marking the initial mount dirty', async () => {
    const onContentChange = renderPane();
    await act(async () => undefined);
    const props = excalidrawMocks.calls[excalidrawMocks.calls.length - 1];

    expect(excalidrawMocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({ currentItemFontFamily: 5, viewBackgroundColor: 'transparent' }),
        elements: [],
        files: {},
      }),
      null,
      null,
      { repairBindings: true },
    );
    expect(props?.initialData).toEqual({
      appState: { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' },
      elements: [],
      files: {},
    });

    act(() => {
      props?.onChange?.(
        [],
        { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' },
        {},
      );
    });

    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('serializes edits through the official local serializer and disables browser file flows', async () => {
    const onContentChange = renderPane();
    await act(async () => undefined);
    const props = excalidrawMocks.calls[excalidrawMocks.calls.length - 1];
    const elements = [{ id: 'changed', type: 'rectangle' }];
    const appState = { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' };
    const files = { 'image-1': { id: 'image-1' } };

    expect(props).toMatchObject({
      aiEnabled: false,
      UIOptions: {
        canvasActions: {
          export: { saveFileToDisk: false },
          loadScene: false,
          saveToActiveFile: false,
        },
      },
      viewModeEnabled: false,
    });

    act(() => {
      props?.onChange?.(elements, appState, files);
    });

    expect(excalidrawMocks.serializeAsJSON).toHaveBeenLastCalledWith(
      elements,
      appState,
      files,
      'local',
    );
    expect(onContentChange).toHaveBeenCalledWith(JSON.stringify({
      appState,
      elements,
      files,
      source: 'mmd',
      type: 'excalidraw',
      version: 2,
    }));
  });

  it('uses Excalidraw view mode for a preview pane', () => {
    renderPane({ editable: false });

    expect(excalidrawMocks.calls[excalidrawMocks.calls.length - 1]?.viewModeEnabled).toBe(true);
  });

  it('updates only library chrome without remounting or serializing the scene', async () => {
    const elements = [{ id: 'shape-1', type: 'rectangle', backgroundColor: '#ff0000' }];
    const appState = { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' };
    const files = { 'image-1': { id: 'image-1', dataURL: 'data:image/png;base64,AA==' } };
    excalidrawMocks.restore.mockReturnValue({ appState, elements, files });
    const scene = JSON.stringify({ appState, elements, files, source: 'mmd', type: 'excalidraw', version: 2 });
    const onContentChange = renderPane({ content: scene });
    const canvas = () => container.querySelector<HTMLElement>('[data-testid="excalidraw-canvas"]');
    const initialMountId = canvas()?.dataset.mountId;
    const initialScene = canvas()?.dataset.initialScene;

    expect(excalidrawMocks.calls[excalidrawMocks.calls.length - 1]?.theme).toBe('light');

    document.documentElement.setAttribute('data-skin', 'shanshui-yemo');
    document.documentElement.setAttribute('data-appearance', 'dark');
    await act(async () => Promise.resolve());

    expect(excalidrawMocks.calls[excalidrawMocks.calls.length - 1]?.theme).toBe('dark');
    expect(canvas()?.dataset.mountId).toBe(initialMountId);
    expect(canvas()?.dataset.initialScene).toBe(initialScene);

    act(() => {
      excalidrawMocks.calls[excalidrawMocks.calls.length - 1]?.onChange?.(
        elements,
        { ...appState, theme: 'dark' },
        files,
      );
    });

    expect(onContentChange).not.toHaveBeenCalled();
    expect(JSON.parse(initialScene ?? '{}')).toEqual({ appState, elements, files });
    expect(appState.viewBackgroundColor).toBe('transparent');
  });

  it('reloads the canvas when another pane synchronizes a new scene', async () => {
    excalidrawMocks.restore.mockImplementation((input) => {
      const scene = input as { appState: unknown; elements: unknown; files: unknown };
      return {
        appState: scene.appState,
        elements: scene.elements,
        files: scene.files,
      };
    });
    renderPane();
    const canvas = () => container.querySelector<HTMLElement>('[data-testid="excalidraw-canvas"]');

    expect(JSON.parse(canvas()?.dataset.initialScene ?? '{}')).toMatchObject({ elements: [] });

    const synchronizedScene = JSON.stringify({
      appState: { currentItemFontFamily: 5, viewBackgroundColor: 'transparent' },
      elements: [{ id: 'synchronized-shape', type: 'rectangle' }],
      files: { 'image-1': { id: 'image-1' } },
      source: 'mmd',
      type: 'excalidraw',
      version: 2,
    });
    renderPane({ content: synchronizedScene });
    await act(async () => undefined);

    expect(JSON.parse(canvas()?.dataset.initialScene ?? '{}')).toMatchObject({
      elements: [{ id: 'synchronized-shape', type: 'rectangle' }],
      files: { 'image-1': { id: 'image-1' } },
    });
  });

  it('routes an invalid scene through the app-level feedback callback', async () => {
    const onInvalidScene = vi.fn<(message: string) => void>();
    renderPane({ content: '{}', onInvalidScene });
    await act(async () => undefined);

    expect(onInvalidScene).toHaveBeenCalledWith('Invalid Excalidraw scene');
    expect(container.querySelector('[data-testid="excalidraw-canvas"]')).toBeNull();
  });
});
