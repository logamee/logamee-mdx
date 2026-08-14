import { AlertTriangle, FilePlus2, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFileKind } from '../types';
import { useI18n, type Translate } from '../lib/i18n';

export type WorkspaceEntryKind = 'file' | 'folder';

export type WorkspaceEntryOperation =
  | {
    fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'>;
    kind: 'create-file';
    parentName: string;
    parentPath: string;
  }
  | { kind: 'create-folder'; parentName: string; parentPath: string }
  | { currentName: string; entryKind: WorkspaceEntryKind; kind: 'rename'; path: string }
  | { currentName: string; entryKind: WorkspaceEntryKind; kind: 'delete'; path: string };

interface WorkspaceEntryDialogProps {
  busy: boolean;
  operation: WorkspaceEntryOperation;
  onCancel: () => void;
  onConfirm: (name?: string) => void;
}

function dialogText(operation: WorkspaceEntryOperation, t: Translate) {
  switch (operation.kind) {
    case 'create-file':
      if (operation.fileKind === 'excalidraw') {
        return {
          confirmLabel: t('create'),
          defaultName: 'Untitled.excalidraw',
          icon: <FilePlus2 size={22} />,
          message: t('createExcalidrawMessage', { parent: operation.parentName }),
          title: t('createExcalidrawTitle'),
        };
      }
      return {
        confirmLabel: t('create'),
        defaultName: 'Untitled.md',
        icon: <FilePlus2 size={22} />,
        message: t('createFileMessage', { parent: operation.parentName }),
        title: t('createFileTitle'),
      };
    case 'create-folder':
      return {
        confirmLabel: t('create'),
        defaultName: 'New Folder',
        icon: <FolderPlus size={22} />,
        message: t('createFolderMessage', { parent: operation.parentName }),
        title: t('createFolderTitle'),
      };
    case 'rename':
      return {
        confirmLabel: t('rename'),
        defaultName: operation.currentName,
        icon: <Pencil size={22} />,
        message: t(operation.entryKind === 'file' ? 'renameFileMessage' : 'renameFolderMessage', { name: operation.currentName }),
        title: t(operation.entryKind === 'file' ? 'renameFileTitle' : 'renameFolderTitle'),
      };
    case 'delete':
      return {
        confirmLabel: t('delete'),
        defaultName: '',
        icon: <Trash2 size={22} />,
        message: t(operation.entryKind === 'file' ? 'deleteFileMessage' : 'deleteFolderMessage', { name: operation.currentName }),
        title: t(operation.entryKind === 'file' ? 'deleteFileTitle' : 'deleteFolderTitle'),
      };
  }
}

export function WorkspaceEntryDialog({ busy, operation, onCancel, onConfirm }: WorkspaceEntryDialogProps) {
  const { t } = useI18n();
  const text = useMemo(() => dialogText(operation, t), [operation, t]);
  const [name, setName] = useState(text.defaultName);
  const isDelete = operation.kind === 'delete';
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(text.defaultName);
    if (isDelete) return undefined;
    const timeout = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const extensionStart = operation.kind === 'create-file' ? text.defaultName.lastIndexOf('.') : -1;
      input.setSelectionRange(0, extensionStart > 0 ? extensionStart : text.defaultName.length);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isDelete, operation.kind, text.defaultName]);

  return (
    <div className="workspace-entry-dialog-backdrop">
      <dialog
        open
        className={isDelete ? 'workspace-entry-dialog danger' : 'workspace-entry-dialog'}
        role={isDelete ? 'alertdialog' : undefined}
        aria-modal="true"
        aria-labelledby="workspace-entry-dialog-title"
        aria-describedby="workspace-entry-dialog-message"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || busy) return;
          event.preventDefault();
          onCancel();
        }}
      >
        <form
          className="workspace-entry-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(isDelete ? undefined : name);
          }}
        >
          <div className={isDelete ? 'workspace-entry-dialog-icon danger' : 'workspace-entry-dialog-icon'}>
            {isDelete ? <AlertTriangle size={22} /> : text.icon}
          </div>
          <div className="workspace-entry-dialog-content">
            <h2 id="workspace-entry-dialog-title">{text.title}</h2>
            <p id="workspace-entry-dialog-message">{text.message}</p>
            {!isDelete && (
              <label className="workspace-entry-dialog-field">
                <span>{t('name')}</span>
                <input
                  ref={inputRef}
                  value={name}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
            )}
            <div className="workspace-entry-dialog-actions">
              <button type="button" className="dialog-button ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
              <button type="submit" className={isDelete ? 'dialog-button danger' : 'dialog-button secondary'} disabled={busy || (!isDelete && !name.trim())}>{text.confirmLabel}</button>
            </div>
          </div>
        </form>
      </dialog>
    </div>
  );
}
