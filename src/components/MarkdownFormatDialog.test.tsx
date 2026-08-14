// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownFormatCommandId } from '../lib/markdownFormatCommands';
import { MarkdownFormatDialog } from './MarkdownFormatDialog';

describe('MarkdownFormatDialog', () => {
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

  it('uses the focus-leave path instead of focus-restoring cancel when focus moves outside', () => {
    const onCancel = vi.fn<() => void>();
    const onFocusLeave = vi.fn<() => void>();
    act(() => {
      root.render(
        <>
          <MarkdownFormatDialog
            onCancel={onCancel}
            onFocusLeave={onFocusLeave}
            onSelect={vi.fn<(command: MarkdownFormatCommandId) => void>()}
          />
          <button type="button" aria-label="Outside control">Outside control</button>
        </>,
      );
    });
    const outsideControl = container.querySelector<HTMLButtonElement>('button[aria-label="Outside control"]');
    expect(document.activeElement).toBe(container.querySelector('[role="combobox"]'));

    act(() => outsideControl?.focus());

    expect(onFocusLeave).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outsideControl);
  });

  it('keeps combobox focus while a pointer selects a command', () => {
    const onSelect = vi.fn<(command: MarkdownFormatCommandId) => void>();
    act(() => {
      root.render(
        <MarkdownFormatDialog
          onCancel={vi.fn<() => void>()}
          onFocusLeave={vi.fn<() => void>()}
          onSelect={onSelect}
        />,
      );
    });
    const combobox = container.querySelector<HTMLInputElement>('[role="combobox"]');
    const boldCommand = container.querySelector<HTMLButtonElement>('[data-command-id="bold"]');
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    expect(document.activeElement).toBe(combobox);

    act(() => boldCommand?.dispatchEvent(pointerDown));

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(combobox);

    act(() => boldCommand?.click());
    expect(onSelect).toHaveBeenCalledWith('bold');
  });
});
