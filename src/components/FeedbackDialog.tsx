import { AlertTriangle, Info } from 'lucide-react';
import type { FeedbackDialog as FeedbackDialogModel } from '../lib/appFeedback';

interface FeedbackDialogProps {
  dialog: FeedbackDialogModel;
  onDismiss: () => void;
}

export function FeedbackDialog({ dialog, onDismiss }: FeedbackDialogProps) {
  return (
    <div className={`app-dialog-backdrop ${dialog.kind}`}>
      <section
        className={`app-dialog ${dialog.kind}`}
        role={dialog.role}
        aria-modal="true"
        aria-labelledby="app-feedback-title"
        aria-describedby="app-feedback-message"
      >
        <div className={`app-dialog-icon ${dialog.kind}`} aria-hidden="true">
          {dialog.kind === 'error' ? <AlertTriangle size={24} /> : <Info size={24} />}
        </div>
        <div className="app-dialog-content">
          <h2 id="app-feedback-title">{dialog.title}</h2>
          <p id="app-feedback-message">{dialog.message}</p>
          <div className="app-dialog-actions">
            <button type="button" className={dialog.kind === 'error' ? 'dialog-button danger' : 'dialog-button secondary'} onClick={onDismiss}>
              {dialog.dismissLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
