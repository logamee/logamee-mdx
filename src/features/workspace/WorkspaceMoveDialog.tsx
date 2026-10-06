import { FolderInput } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WorkspaceMoveDestination } from '../../lib/fileTreeOperations';
import { useI18n } from '../../lib/i18n';

export interface WorkspaceMoveOperation {
  currentName: string;
  entryKind: 'file' | 'folder';
  path: string;
}

interface WorkspaceMoveDialogProps {
  busy: boolean;
  destinations: WorkspaceMoveDestination[];
  onCancel: () => void;
  onConfirm: (destinationParentPath: string) => void;
  operation: WorkspaceMoveOperation;
}

export function WorkspaceMoveDialog({
  busy,
  destinations,
  onCancel,
  onConfirm,
  operation,
}: WorkspaceMoveDialogProps) {
  const { t } = useI18n();
  const [destinationPath, setDestinationPath] = useState(destinations[0]?.path ?? '');

  useEffect(() => {
    setDestinationPath(destinations[0]?.path ?? '');
  }, [destinations, operation.path]);

  return (
    <div className="workspace-entry-dialog-backdrop">
      <dialog
        open
        className="workspace-entry-dialog workspace-move-dialog"
        aria-modal="true"
        aria-labelledby="workspace-move-dialog-title"
        aria-describedby="workspace-move-dialog-message"
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); } }}
      >
        <form
          className="workspace-entry-dialog-form"
          onSubmit={(event) => { event.preventDefault(); if (destinationPath) onConfirm(destinationPath); }}
        >
          <div className="workspace-entry-dialog-icon" aria-hidden="true">
            <FolderInput size={22} />
          </div>
          <div className="workspace-entry-dialog-content">
            <h2 id="workspace-move-dialog-title">{t('moveTitle', { name: operation.currentName })}</h2>
            <p id="workspace-move-dialog-message">{t('moveMessage')}</p>
            <MoveDestinationField busy={busy} destinationPath={destinationPath} destinations={destinations} onSelect={setDestinationPath} />
            {destinations.length === 0 && <p className="workspace-move-empty">{t('noMoveDestination')}</p>}
            <div className="workspace-entry-dialog-actions">
              <button type="button" className="dialog-button ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
              <button type="submit" className="dialog-button secondary" disabled={busy || !destinationPath}>{t('move')}</button>
            </div>
          </div>
        </form>
      </dialog>
    </div>
  );
}

// 目的地选择器：无目的地时禁用。
function MoveDestinationField(props: {
  busy: boolean;
  destinationPath: string;
  destinations: readonly { path: string; label: string }[];
  onSelect: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="workspace-entry-dialog-field">
      <span>{t('moveTo')}</span>
      <select
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- 模态对话框打开时聚焦目的地选择器是预期行为
        autoFocus
        value={props.destinationPath}
        disabled={props.busy || props.destinations.length === 0}
        onChange={(event) => props.onSelect(event.currentTarget.value)}
      >
        {props.destinations.map((destination) => (
          <option key={destination.path} value={destination.path}>
            {destination.label}
          </option>
        ))}
      </select>
    </label>
  );
}
