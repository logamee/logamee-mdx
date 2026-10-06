import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExternalFileChangeDialog } from './ExternalFileChangeDialog';

const handlers = {
  onCloseDeletedDraft: vi.fn<() => void>(),
  onKeepCurrent: vi.fn<() => void>(),
  onSaveDeletedDraftAs: vi.fn<() => void>(),
  onUseExternal: vi.fn<() => void>(),
};

describe('ExternalFileChangeDialog', () => {
  it('renders one blocking conflict alert with only the two resolution actions', () => {
    const html = renderToStaticMarkup(
      <ExternalFileChangeDialog
        action={{ busy: false, kind: 'conflict', path: '/workspace/notes.md' }}
        {...handlers}
      />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="external-file-change-title"');
    expect(html).toContain('aria-describedby="external-file-change-message"');
    expect(html).toContain('notes.md');
    expect(html).toContain('Use External Version');
    expect(html).toContain('Overwrite with Current Edits');
    expect(html).toContain('dialog-button danger');
    expect(html).not.toContain('Save As');
    expect(html).not.toContain('Close Without Saving');
  });

  it('renders non-dismissible deleted-draft recovery with disabled actions while busy', () => {
    const html = renderToStaticMarkup(
      <ExternalFileChangeDialog
        action={{ busy: true, kind: 'deleted-draft', path: '/workspace/draft.md' }}
        {...handlers}
      />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('draft.md');
    expect(html).toContain('Save As');
    expect(html).toContain('Close Without Saving');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('Use External Version');
    expect(html).not.toContain('Keep Current Edits');
  });
});
