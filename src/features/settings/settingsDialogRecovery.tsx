import { RotateCcw, Settings2 } from 'lucide-react';
import type { SettingsRecovery } from './useSettings';
import type { SettingsDialogText } from './settingsDialogCopy';

// 设置恢复/冲突/未来版本告警对话框。
export function SettingsRecoveryDialog(props: {
  busy: boolean;
  onReset: () => Promise<void>;
  onRetry?: () => Promise<void>;
  recovery: SettingsRecovery;
  text: SettingsDialogText;
}) {
  const { busy, onReset, onRetry, recovery, text } = props;
  const isFuture = recovery.kind === 'future';
  const isConflict = recovery.kind === 'conflict';
  const title = isConflict ? text.conflictTitle : isFuture ? text.futureTitle : text.recoveryTitle;
  const message = isConflict ? text.conflictMessage : isFuture ? text.futureMessage : text.recoveryMessage;
  return (
    <div className="settings-dialog-backdrop">
      <dialog open className="settings-dialog recovery" role="alertdialog" aria-modal="true" aria-labelledby="settings-recovery-title" aria-describedby="settings-recovery-message">
        <div className="settings-dialog-heading">
          <Settings2 size={18} aria-hidden="true" />
          <h2 id="settings-recovery-title">{title}</h2>
        </div>
        <p id="settings-recovery-message">{message}</p>
        <div className="settings-dialog-actions">
          {!isFuture && !isConflict && <button type="button" className="dialog-button ghost" disabled={busy || !recovery.canReset} onClick={() => void onReset()}><RotateCcw size={14} aria-hidden="true" />{text.reset}</button>}
          <button type="button" className="dialog-button secondary" disabled={busy || !onRetry} onClick={() => void onRetry?.()}>{isConflict ? text.reload : text.retry}</button>
        </div>
      </dialog>
    </div>
  );
}
