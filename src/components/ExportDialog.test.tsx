// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './ExportDialog';

describe('ExportDialog', () => {
  it('blocks export when preflight reports issues', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<ExportDialog busy={false} canExportExcalidraw={false} issues={[{ kind: 'missing-image', message: 'missing' }]} locale="en" value={{ format: 'html', scale: 2, theme: 'current' }} onCancel={vi.fn<() => void>()} onChange={vi.fn<(value: { format: 'html' | 'png' | 'excalidraw'; scale: 1 | 2 | 3; theme: 'light' | 'dark' | 'current' }) => void>()} onExport={vi.fn<() => void>()} />));
    expect(container.querySelector('dialog')?.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('.dialog-button.secondary')?.disabled).toBe(true);
    act(() => root.unmount());
  });
});
