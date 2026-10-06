// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateAvailableDialog } from './UpdateAvailableDialog';

describe('UpdateAvailableDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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

  it('offers update, later, and skip-version actions in a modal', async () => {
    const onUpdate = vi.fn<() => Promise<void>>(async () => undefined);
    const onLater = vi.fn<() => void>();
    const onSkip = vi.fn<() => void>();
    await act(async () => root.render(
      <UpdateAvailableDialog
        locale="en"
        version="1.2.3"
        currentVersion="1.0.0"
        body="Important fixes"
        busy={false}
        onUpdate={onUpdate}
        onLater={onLater}
        onSkip={onSkip}
      />,
    ));

    expect(container.querySelector('dialog')?.getAttribute('aria-modal')).toBe('true');
    expect(container.textContent).toContain('mdx 1.2.3');
    expect(container.textContent).toContain('Important fixes');
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent === 'Update now')?.click());
    act(() => buttons.find((button) => button.textContent === 'Later')?.click());
    act(() => buttons.find((button) => button.textContent === 'Skip this version')?.click());
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onLater).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
