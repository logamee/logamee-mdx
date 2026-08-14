// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCrashDraftError } from '../lib/crashDrafts';
import { CrashDraftStoreRepairDialog } from './CrashDraftStoreRepairDialog';

const error: ProjectedCrashDraftError = {
  code: 'storeFull',
  message: 'Crash draft storage is full. Save important documents to keep their edits.',
  canReset: false,
  repairReceipt: 'secret-repair-receipt',
};

describe('CrashDraftStoreRepairDialog', () => {
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

  it('renders only for a projected error and exposes safe modal feedback', async () => {
    await act(async () => root.render(
      <CrashDraftStoreRepairDialog
        busy={false}
        canRepairOverflow={false}
        error={null}
        locale="en"
        overflowRepairProgress={null}
        onRepairOverflow={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
      />,
    ));
    expect(container.innerHTML).toBe('');

    await act(async () => root.render(
      <CrashDraftStoreRepairDialog
        busy={false}
        canRepairOverflow
        error={error}
        locale="en"
        overflowRepairProgress={{ removedEntries: 3, blockedEntries: 1, moreWorkRemaining: true, repairReceipt: 'next-secret-receipt' }}
        onRepairOverflow={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
      />,
    ));

    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.textContent).toContain(error.message);
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('1');
    expect(container.textContent).not.toContain('secret-repair-receipt');
    expect(container.textContent).not.toContain('next-secret-receipt');
  });

  it('calls retry and one repair batch exactly once per click without an effect loop', async () => {
    const onRetry = vi.fn<() => Promise<void>>(async () => undefined);
    const onRepairOverflow = vi.fn<() => Promise<unknown>>(async () => undefined);
    await act(async () => root.render(
      <CrashDraftStoreRepairDialog
        busy={false}
        canRepairOverflow
        error={error}
        locale="en"
        overflowRepairProgress={null}
        onRepairOverflow={onRepairOverflow}
        onRetry={onRetry}
      />,
    ));

    expect(onRetry).not.toHaveBeenCalled();
    expect(onRepairOverflow).not.toHaveBeenCalled();
    const button = (label: string) => [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes(label));
    act(() => button('Retry')?.click());
    act(() => button('Repair Draft Storage')?.click());

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRepairOverflow).toHaveBeenCalledTimes(1);
  });

  it('disables actions while busy and supports a later repair batch after rerender', async () => {
    const onRepairOverflow = vi.fn<() => void>();
    const renderDialog = async (busy: boolean, canRepairOverflow: boolean) => act(async () => root.render(
      <CrashDraftStoreRepairDialog
        busy={busy}
        canRepairOverflow={canRepairOverflow}
        error={error}
        locale="zh-CN"
        overflowRepairProgress={{ removedEntries: 2, blockedEntries: 0, moreWorkRemaining: true, repairReceipt: 'hidden' }}
        onRepairOverflow={onRepairOverflow}
        onRetry={vi.fn<() => void>()}
      />,
    ));

    await renderDialog(true, true);
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('修复草稿存储'))?.click());
    expect(onRepairOverflow).not.toHaveBeenCalled();

    await renderDialog(false, true);
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('修复草稿存储'))?.click());
    expect(onRepairOverflow).toHaveBeenCalledTimes(1);

    await renderDialog(false, false);
    expect(container.textContent).not.toContain('修复草稿存储');
  });
});
