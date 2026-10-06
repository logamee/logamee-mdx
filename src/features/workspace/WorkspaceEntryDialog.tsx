import { AlertTriangle, FilePlus2, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFileKind } from '../../types';
import { useI18n, type Translate } from '../../lib/i18n';

type WorkspaceEntryKind = 'file' | 'folder';

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

  useEntryDialogFocus({ defaultName: text.defaultName, isDelete, kind: operation.kind, inputRef });

  return (
    <div className="workspace-entry-dialog-backdrop">
      <dialog
        open
        className={isDelete ? 'workspace-entry-dialog danger' : 'workspace-entry-dialog'}
        role={isDelete ? 'alertdialog' : undefined}
        aria-modal="true"
        aria-labelledby="workspace-entry-dialog-title"
        aria-describedby="workspace-entry-dialog-message"
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); } }}
      >
        <form
          className="workspace-entry-dialog-form"
          onSubmit={(event) => { event.preventDefault(); onConfirm(isDelete ? undefined : name); }}
        >
          <div className={isDelete ? 'workspace-entry-dialog-icon danger' : 'workspace-entry-dialog-icon'}>
            {isDelete ? <AlertTriangle size={22} /> : text.icon}
          </div>
          <div className="workspace-entry-dialog-content">
            <h2 id="workspace-entry-dialog-title">{text.title}</h2>
            <p id="workspace-entry-dialog-message">{text.message}</p>
            {!isDelete && <EntryDialogNameField busy={busy} inputRef={inputRef} name={name} onNameChange={setName} />}
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

// 名称输入字段。
function EntryDialogNameField(props: {
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  name: string;
  onNameChange: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="workspace-entry-dialog-field">
      <span>{t('name')}</span>
      <input
        ref={props.inputRef}
        value={props.name}
        disabled={props.busy}
        spellCheck={false}
        onChange={(event) => props.onNameChange(event.currentTarget.value)}
      />
    </label>
  );
}

// 非删除操作挂载后聚焦名称输入并选中不含扩展名的前缀。
function useEntryDialogFocus(deps: {
  defaultName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isDelete: boolean;
  kind: string;
}): void {
  const { defaultName, inputRef, isDelete, kind } = deps;
  useEffect(() => {
    if (isDelete) return undefined;
    const timeout = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const extensionStart = kind === 'create-file' ? defaultName.lastIndexOf('.') : -1;
      input.setSelectionRange(0, extensionStart > 0 ? extensionStart : defaultName.length);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [defaultName, inputRef, isDelete, kind]);
}
