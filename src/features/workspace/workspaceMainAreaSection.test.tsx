// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneResize } from '../app/usePaneResize';
import { useWorkspaceSidebarResize } from '../app/useWorkspaceSidebarResize';
import { DEFAULT_WORKSPACE_SIDEBAR_WIDTH } from '../../lib/sidebarLayout';
import { WorkspaceMainAreaSection, type WorkspaceMainAreaComposites } from './workspaceMainAreaSection';

vi.mock('./FileSidebar', () => ({ FileSidebar: (): null => null }));
vi.mock('./EditorPane', () => ({ EditorPane: (): null => null }));
vi.mock('../preview/markdownPreviewContent', () => ({ MarkdownPreviewContent: (): null => null, PreviewPane: (): null => null }));

const noop = (): void => undefined;

function Harness() {
  const [editorPaneRatio, setEditorPaneRatio] = useState(0.5);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
  const paneResize = usePaneResize({ editorPaneRatio, setEditorPaneRatio });
  const sidebarResize = useWorkspaceSidebarResize({ setSidebarWidth, sidebarWidth });
  const ctx = {
    fileTreeCollapsed: false,
    layout: { editorPaneRatio, paneLayoutStyle: {}, sidebarLayoutStyle: {} },
    panels: { tree: {} },
    paneResize,
    paneSurface: {
      editorFontSize: { fontSize: 16, decrease: noop, increase: noop, reset: noop },
      settingsState: { settings: null },
    },
    paneViews: {},
    session: { activeFileKind: 'markdown' },
    sidebarResize,
    sidebarWidth,
  } as unknown as WorkspaceMainAreaComposites;
  return <WorkspaceMainAreaSection ctx={ctx} />;
}

describe('WorkspaceMainAreaSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['pane resizer', '.pane-resizer', '52'],
    ['sidebar resizer', '.workspace-sidebar-resizer', '280'],
  ])('marks the main area as resizing for a keyboard step on the %s and clears it on key-up or blur', (_, selector, steppedValue) => {
    act(() => root.render(<Harness />));
    const resizer = container.querySelector<HTMLButtonElement>(selector);
    const isResizing = () => container.querySelector('main')?.classList.contains('is-resizing') ?? false;
    expect(resizer).not.toBeNull();
    expect(isResizing()).toBe(false);

    act(() => resizer?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })));
    expect(resizer?.getAttribute('aria-valuenow')).toBe(steppedValue);
    expect(isResizing()).toBe(true);

    act(() => resizer?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' })));
    expect(isResizing()).toBe(false);

    act(() => resizer?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })));
    expect(isResizing()).toBe(true);

    act(() => resizer?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(isResizing()).toBe(false);
  });
});
