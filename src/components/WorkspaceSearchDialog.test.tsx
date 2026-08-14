// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceIndexRebuildResponse } from '../types';
import { WorkspaceSearchDialog, type WorkspaceSearchSelection } from './WorkspaceSearchDialog';

const rebuildWorkspaceIndex = vi.hoisted(() => (
  vi.fn<typeof import('../lib/tauriCommands').rebuildWorkspaceIndex>()
));
const queryWorkspaceIndex = vi.hoisted(() => (
  vi.fn<typeof import('../lib/tauriCommands').queryWorkspaceIndex>()
));
const cancelWorkspaceIndexOperation = vi.hoisted(() => (
  vi.fn<typeof import('../lib/tauriCommands').cancelWorkspaceIndexOperation>()
));

vi.mock('../lib/tauriCommands', () => ({
  rebuildWorkspaceIndex,
  queryWorkspaceIndex,
  cancelWorkspaceIndexOperation,
}));

const skipCounts = {
  unsupported: 0,
  invalidRelativePath: 0,
  duplicatePath: 0,
  oversized: 0,
  aggregateLimit: 0,
  fileCountLimit: 0,
};

const readyRebuild = {
  status: 'ready' as const,
  workspaceToken: 'workspace-7',
  indexGeneration: 3,
  implementationId: 'mmd-memory-substring-v1',
  schemaId: 'mmd-workspace-index-v1',
  report: {
    implementationId: 'mmd-memory-substring-v1',
    schemaId: 'mmd-workspace-index-v1',
    corpusDigest: 'a'.repeat(64),
    limits: {
      maxFiles: 100_000,
      maxFileBytes: 1_048_576,
      maxAggregateBytes: 268_435_456,
      maxResults: 100,
      maxQueryChars: 256,
      maxSnippetChars: 240,
    },
    inputFiles: 0,
    indexedFiles: 0,
    indexedBytes: 0,
    estimatedIndexBytes: 0,
    skipped: skipCounts,
  },
  scanReport: {
    scannedFiles: 0,
    collectedFiles: 0,
    collectedBytes: 0,
    readErrors: 0,
    skipped: skipCounts,
  },
} satisfies WorkspaceIndexRebuildResponse;

describe('WorkspaceSearchDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    rebuildWorkspaceIndex.mockReset().mockResolvedValue(readyRebuild);
    queryWorkspaceIndex.mockReset();
    cancelWorkspaceIndexOperation.mockReset().mockResolvedValue(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(mode: 'quick-open' | 'workspace-search' = 'quick-open') {
    const onSelect = vi.fn<(selection: WorkspaceSearchSelection) => void>();
    await act(async () => {
      root.render(
        <WorkspaceSearchDialog
          mode={mode}
          workspaceRoot="/workspace"
          workspaceToken="workspace-7"
          onCancel={vi.fn<() => void>()}
          onError={vi.fn<(error: unknown) => void>()}
          onSelect={onSelect}
        />,
      );
      await Promise.resolve();
    });
    return onSelect;
  }

  async function enterQuery(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  }

  it('rebuilds the authorized workspace and sends only a relative result selection', async () => {
    queryWorkspaceIndex.mockResolvedValue({
      status: 'ready',
      workspaceToken: 'workspace-7',
      indexGeneration: 3,
      implementationId: 'mmd-memory-substring-v1',
      schemaId: 'mmd-workspace-index-v1',
      truncated: false,
      results: [{ relativePath: 'notes/draft.md', snippet: null, location: null }],
    });
    const onSelect = await render();
    const input = container.querySelector<HTMLInputElement>('.workspace-search-input input');

    expect(rebuildWorkspaceIndex).toHaveBeenCalledWith('workspace-7', '/workspace', expect.any(String));
    await enterQuery(input!, 'draft');
    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryWorkspaceIndex).toHaveBeenCalledWith(
      'workspace-7',
      '/workspace',
      expect.any(String),
      { kind: 'filename', text: 'draft' },
    );
    const result = container.querySelector<HTMLButtonElement>('[data-relative-path="notes/draft.md"]');
    act(() => result?.click());
    expect(onSelect).toHaveBeenCalledWith({
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      indexGeneration: 3,
      relativePath: 'notes/draft.md',
    });
  });

  it('uses full-text queries and cancels an obsolete debounced request', async () => {
    queryWorkspaceIndex.mockImplementation(() => new Promise(() => undefined));
    await render('workspace-search');
    const input = container.querySelector<HTMLInputElement>('.workspace-search-input input');

    await enterQuery(input!, 'first');
    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
    });
    await enterQuery(input!, 'second');

    expect(queryWorkspaceIndex).toHaveBeenCalledWith(
      'workspace-7',
      '/workspace',
      expect.any(String),
      { kind: 'fullText', text: 'first' },
    );
    expect(cancelWorkspaceIndexOperation).toHaveBeenCalledWith(expect.any(String));
  });
});
