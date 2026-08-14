import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedbackDialog } from './FeedbackDialog';
import { UnsavedExitDialog } from './UnsavedExitDialog';
import { WorkspaceEntryDialog } from './WorkspaceEntryDialog';
import { WorkspaceMoveDialog } from './WorkspaceMoveDialog';

describe('shell modal dialogs', () => {
  it('renders feedback as a modal alert dialog with stable labels and message ids', () => {
    const html = renderToStaticMarkup(
      <FeedbackDialog
        dialog={{ kind: 'error', role: 'alertdialog', title: '出现问题', message: 'Permission denied', dismissLabel: '知道了' }}
        onDismiss={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="app-feedback-title"');
    expect(html).toContain('aria-describedby="app-feedback-message"');
    expect(html).toContain('id="app-feedback-title"');
    expect(html).toContain('出现问题');
    expect(html).toContain('id="app-feedback-message"');
    expect(html).toContain('Permission denied');
    expect(html).toContain('知道了');
  });

  it('renders unsaved exit prompt as a modal dialog with all branching actions', () => {
    const html = renderToStaticMarkup(
      <UnsavedExitDialog
        busy={false}
        prompt={{ title: '有未保存的更改', message: '“draft.md” 尚未保存。退出前要保存吗？', saveLabel: '保存', cancelLabel: '取消', quitLabel: '退出程序' }}
        onCancelExit={vi.fn<() => void>()}
        onQuitWithoutSaving={vi.fn<() => void>()}
        onSaveAndQuit={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="unsaved-exit-title"');
    expect(html).toContain('aria-describedby="unsaved-exit-message"');
    expect(html).toContain('id="unsaved-exit-title"');
    expect(html).toContain('有未保存的更改');
    expect(html).toContain('id="unsaved-exit-message"');
    expect(html).toContain('draft.md');
    expect(html).toContain('保存');
    expect(html).toContain('取消');
    expect(html).toContain('退出程序');
  });

  it('renders workspace entry operations as modal dialogs with input or destructive confirmation', () => {
    const createHtml = renderToStaticMarkup(
      <WorkspaceEntryDialog
        busy={false}
        operation={{ fileKind: 'markdown', kind: 'create-file', parentName: 'workspace root', parentPath: '/workspace' }}
        onCancel={vi.fn<() => void>()}
        onConfirm={vi.fn<() => void>()}
      />,
    );
    const deleteHtml = renderToStaticMarkup(
      <WorkspaceEntryDialog
        busy={false}
        operation={{ currentName: 'drafts', entryKind: 'folder', kind: 'delete', path: '/workspace/drafts' }}
        onCancel={vi.fn<() => void>()}
        onConfirm={vi.fn<() => void>()}
      />,
    );

    expect(createHtml).toContain('<dialog');
    expect(createHtml).toContain('aria-modal="true"');
    expect(createHtml).toContain('aria-labelledby="workspace-entry-dialog-title"');
    expect(createHtml).toContain('value="Untitled.md"');
    expect(deleteHtml).toContain('role="alertdialog"');
    expect(deleteHtml).toContain('Move Folder to Trash');
    expect(deleteHtml).toContain('You can restore it from the system Trash');
    expect(deleteHtml).not.toContain('Permanently delete');
    expect(deleteHtml).not.toContain('This cannot be undone');
  });

  it('uses an Excalidraw-specific default name when creating a drawing', () => {
    const html = renderToStaticMarkup(
      <WorkspaceEntryDialog
        busy={false}
        operation={{ fileKind: 'excalidraw', kind: 'create-file', parentName: 'workspace root', parentPath: '/workspace' }}
        onCancel={vi.fn<() => void>()}
        onConfirm={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('New Excalidraw File');
    expect(html).toContain('value="Untitled.excalidraw"');
  });

  it('renders a keyboard-accessible move sheet with explicit destination choices', () => {
    const html = renderToStaticMarkup(
      <WorkspaceMoveDialog
        busy={false}
        destinations={[
          { label: 'Workspace Root', path: '/workspace' },
          { label: 'archive', path: '/workspace/archive' },
        ]}
        operation={{ currentName: 'draft.md', entryKind: 'file', path: '/workspace/notes/draft.md' }}
        onCancel={vi.fn<() => void>()}
        onConfirm={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="workspace-move-dialog-title"');
    expect(html).toContain('Move “draft.md”');
    expect(html).toContain('<select');
    expect(html).toContain('Workspace Root');
    expect(html).toContain('archive');
  });
});
