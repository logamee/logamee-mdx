// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSaveConflictDialog } from './DocumentSaveConflictDialog';

describe('DocumentSaveConflictDialog', () => {
  it('offers explicit overwrite and cancel actions without exposing save credentials', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onCancel = vi.fn<() => void>();
    const onOverwrite = vi.fn<() => void>();
    act(() => root.render(
      <DocumentSaveConflictDialog
        conflict={{ busy: false, path: '/workspace/note.md' }}
        onCancel={onCancel}
        onOverwrite={onOverwrite}
      />,
    ));
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(container.textContent).toContain('note.md');
    expect(container.textContent).toContain('outside mdx');
    expect(container.textContent).not.toContain('token');
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click());
    act(() => buttons.find((button) => button.textContent === 'Overwrite')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onOverwrite).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
