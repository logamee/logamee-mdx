import { useEffect, useState, type FormEvent } from 'react';
import { Settings2, X } from 'lucide-react';
import type { AppSettings } from '../../types';
import type { EffectiveLocale } from '../../lib/locale';
import type { SettingsRecovery } from './useSettings';
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE } from '../../lib/settings';
import { findShortcutConflicts, resolveShortcutProfile } from '../../lib/shortcutProfiles';
import { copy } from './settingsDialogCopy';
import { SettingsRecoveryDialog } from './settingsDialogRecovery';
import {
  SettingsAppearanceSection,
  SettingsDialogActions,
  SettingsAutosaveSection,
  SettingsResourceSection,
  SettingsShortcutsSection,
  SettingsWorkspaceIndexSection,
} from './settingsDialogSections';

interface SettingsDialogProps {
  busy: boolean;
  locale: EffectiveLocale;
  settings?: AppSettings | null;
  recovery?: SettingsRecovery | null;
  onClose?: () => void;
  onReset: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onSave?: (settings: AppSettings) => Promise<void>;
  onAuthorizeResourceDirectory?: () => Promise<string | null>;
  workspaceAvailable?: boolean;
  onDiscardWorkspaceIndex?: () => Promise<void>;
  onRebuildWorkspaceIndex?: () => Promise<void>;
}

export function SettingsDialog({
  busy, locale, settings, recovery = null, onClose, onReset, onRetry, onSave,
  onAuthorizeResourceDirectory, workspaceAvailable = false, onDiscardWorkspaceIndex, onRebuildWorkspaceIndex,
}: SettingsDialogProps) {
  const text = copy[locale];
  const [draft, setDraft] = useState<AppSettings | null>(() => withResolvedShortcuts(settings));
  useEffect(() => setDraft(withResolvedShortcuts(settings)), [settings]);

  if (recovery) {
    return <SettingsRecoveryDialog busy={busy} onReset={onReset} onRetry={onRetry} recovery={recovery} text={text} />;
  }
  if (!draft || !onSave || !onClose) return null;

  const validation = validateSettingsDraft(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validation.saveAllowed) return;
    void onSave({ ...draft, shortcuts: resolveShortcutProfile(draft.shortcuts) });
  };
  const sectionProps = { draft, setDraft, text };


  return (
    <div className="settings-dialog-backdrop">
      <dialog open className="settings-dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <form onSubmit={submit}>
          <SettingsDialogHeader cancelLabel={text.cancel} onClose={onClose} title={text.title} />

          <SettingsAutosaveSection {...sectionProps} />
          {validation.autosaveDelayInvalid && <p className="settings-validation" role="alert">{text.autosaveDelayInvalid}</p>}
          <SettingsShortcutsSection {...sectionProps} shortcutConflicts={validation.shortcutConflicts} shortcutsValid={validation.shortcutsValid} />
          <SettingsResourceSection {...sectionProps} busy={busy} onAuthorizeResourceDirectory={onAuthorizeResourceDirectory} />
          <SettingsAppearanceSection {...sectionProps} locale={locale} />
          {validation.fontSizeInvalid && <p className="settings-validation" role="alert">{text.fontSizeInvalid}</p>}
          <SettingsWorkspaceIndexSection busy={busy} onDiscardWorkspaceIndex={onDiscardWorkspaceIndex} onRebuildWorkspaceIndex={onRebuildWorkspaceIndex} text={text} workspaceAvailable={workspaceAvailable} />

          <SettingsDialogActions busy={busy} cancel={onClose} onReset={onReset} saveAllowed={validation.saveAllowed} text={text} />
        </form>
      </dialog>
    </div>
  );
}

// 对话框头：标题与关闭按钮。
function SettingsDialogHeader(props: { cancelLabel: string; onClose: () => void; title: string }) {
  return (
    <header className="settings-dialog-header">
      <div className="settings-dialog-heading"><Settings2 size={18} aria-hidden="true" /><h2 id="settings-dialog-title">{props.title}</h2></div>
      <button type="button" className="settings-dialog-close" aria-label={props.cancelLabel} title={props.cancelLabel} onClick={props.onClose}><X size={17} /></button>
    </header>
  );
}

function withResolvedShortcuts(value: AppSettings | null | undefined): AppSettings | null {
  return value ? { ...value, shortcuts: resolveShortcutProfile(value.shortcuts) } : null;
}

// 草稿校验：快捷键可解析且无冲突、延迟与字号在界内才允许保存。
function validateSettingsDraft(draft: AppSettings): {
  autosaveDelayInvalid: boolean;
  fontSizeInvalid: boolean;
  saveAllowed: boolean;
  shortcutConflicts: { shortcut: string }[];
  shortcutsValid: boolean;
} {
  let shortcutConflicts: { shortcut: string }[] = [];
  let shortcutsValid = true;
  try {
    shortcutConflicts = findShortcutConflicts(draft.shortcuts);
  } catch {
    shortcutsValid = false;
  }
  const autosaveDelayInvalid = !Number.isFinite(draft.autosaveDelayMs)
    || draft.autosaveDelayMs < 250
    || draft.autosaveDelayMs > 60000;
  const fontSizeInvalid = !Number.isFinite(draft.editorFontSize)
    || draft.editorFontSize < MIN_EDITOR_FONT_SIZE
    || draft.editorFontSize > MAX_EDITOR_FONT_SIZE;
  return {
    autosaveDelayInvalid,
    fontSizeInvalid,
    saveAllowed: shortcutsValid && shortcutConflicts.length === 0 && !autosaveDelayInvalid && !fontSizeInvalid,
    shortcutConflicts,
    shortcutsValid,
  };
}
