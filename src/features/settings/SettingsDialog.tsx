import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { FolderCog, Keyboard, Palette, Settings2, SlidersHorizontal, X } from 'lucide-react';
import type { AppSettings } from '../../types';
import type { EffectiveLocale } from '../../lib/locale';
import type { SettingsRecovery } from './useSettings';
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, previewEditorFontSize } from '../../lib/settings';
import { findShortcutConflicts, resolveShortcutProfile } from '../../lib/shortcutProfiles';
import { previewEffectiveTheme, resolveEffectiveTheme } from '../../lib/theme';
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

function useLiveAppearancePreview(
  draft: AppSettings | null,
  settings: AppSettings,
) {
  const selectedSkin = draft?.selectedSkin;
  const followSystemTheme = draft?.followSystemTheme;
  const themeChanged = selectedSkin !== settings.selectedSkin || followSystemTheme !== settings.followSystemTheme;
  const editorFontSize = draft?.editorFontSize;
  useLayoutEffect(() => {
    if (!themeChanged || !selectedSkin || followSystemTheme === undefined) return;
    const effective = resolveEffectiveTheme(
      { version: 1, selectedSkin, followSystem: followSystemTheme },
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    );
    return previewEffectiveTheme(document.documentElement, effective);
  }, [followSystemTheme, selectedSkin, themeChanged]);
  useLayoutEffect(() => {
    if (editorFontSize === settings.editorFontSize || editorFontSize === undefined || !Number.isFinite(editorFontSize)
      || editorFontSize < MIN_EDITOR_FONT_SIZE || editorFontSize > MAX_EDITOR_FONT_SIZE) return;
    return previewEditorFontSize(document.documentElement, editorFontSize);
  }, [editorFontSize, settings.editorFontSize]);
}

function useSettingsFocus(busy: boolean, onClose: () => void) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!closeButton.current) return;
    const opener = document.activeElement;
    const dialog = closeButton.current.closest('dialog');
    closeButton.current.focus();
    return () => {
      if (opener instanceof HTMLElement && (dialog?.contains(document.activeElement) || document.activeElement === document.body)) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || closeButton.current?.closest('[inert]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [busy, onClose]);
  return closeButton;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { busy, locale, settings, recovery, onClose, onReset, onRetry, onSave } = props;
  if (recovery) {
    return <SettingsRecoveryDialog busy={busy} onReset={onReset} onRetry={onRetry} recovery={recovery} text={copy[locale]} />;
  }
  if (!settings || !onClose || !onSave) return null;
  return <SettingsForm {...props} settings={settings} onClose={onClose} onSave={onSave} />;
}

function SettingsForm({
  busy, locale, settings, onClose, onReset, onSave,
  onAuthorizeResourceDirectory, workspaceAvailable = false, onDiscardWorkspaceIndex, onRebuildWorkspaceIndex,
}: SettingsDialogProps & { settings: AppSettings; onClose: () => void; onSave: NonNullable<SettingsDialogProps['onSave']> }) {
  const text = copy[locale];
  const [source, setSource] = useState(settings);
  const [draft, setDraft] = useState(() => withResolvedShortcuts(settings));
  const [activeTab, setActiveTab] = useState('general');
  const closeButton = useSettingsFocus(busy, onClose);
  useLiveAppearancePreview(draft, settings);
  if (source !== settings) {
    setSource(settings);
    setDraft(withResolvedShortcuts(settings));
  }

  const validation = validateSettingsDraft(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !validation.saveAllowed) return;
    void onSave({ ...draft, shortcuts: resolveShortcutProfile(draft.shortcuts) });
  };
  const sectionProps = { draft, setDraft, text };

  return (
    <div
      className="settings-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <dialog
        open
        className="settings-dialog settings-tabs-dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <form onSubmit={submit}>
          <SettingsDialogHeader busy={busy} buttonRef={closeButton} cancelLabel={text.cancel} onClose={onClose} title={text.title} />
          <Tabs.Root className="settings-tabs-layout" orientation="vertical" value={activeTab} onValueChange={setActiveTab}>
            <Tabs.List className="settings-tab-list" aria-label={text.title}>
              <Tabs.Trigger className="settings-tab-trigger" value="general"><SlidersHorizontal size={14} aria-hidden="true" /><span>{text.tabGeneral}</span></Tabs.Trigger>
              <Tabs.Trigger className="settings-tab-trigger" value="appearance"><Palette size={14} aria-hidden="true" /><span>{text.tabAppearance}</span></Tabs.Trigger>
              <Tabs.Trigger className="settings-tab-trigger" value="shortcuts"><Keyboard size={14} aria-hidden="true" /><span>{text.tabShortcuts}</span></Tabs.Trigger>
              <Tabs.Trigger className="settings-tab-trigger" value="workspace"><FolderCog size={14} aria-hidden="true" /><span>{text.tabWorkspace}</span></Tabs.Trigger>
            </Tabs.List>
            <div className="settings-tab-panels">
              <Tabs.Content className="settings-tab-panel" forceMount value="general">
                <SettingsAutosaveSection {...sectionProps} />
              </Tabs.Content>
              <Tabs.Content className="settings-tab-panel" forceMount value="appearance">
                <SettingsAppearanceSection {...sectionProps} locale={locale} />
              </Tabs.Content>
              <Tabs.Content className="settings-tab-panel" forceMount value="shortcuts">
                <SettingsShortcutsSection {...sectionProps} />
              </Tabs.Content>
              <Tabs.Content className="settings-tab-panel" forceMount value="workspace">
                <SettingsResourceSection {...sectionProps} busy={busy} onAuthorizeResourceDirectory={onAuthorizeResourceDirectory} />
                <SettingsWorkspaceIndexSection busy={busy} onDiscardWorkspaceIndex={onDiscardWorkspaceIndex} onRebuildWorkspaceIndex={onRebuildWorkspaceIndex} text={text} workspaceAvailable={workspaceAvailable} />
              </Tabs.Content>
            </div>
          </Tabs.Root>
          <SettingsValidation validation={validation} text={text} />
          <SettingsDialogActions busy={busy} cancel={onClose} onReset={onReset} saveAllowed={validation.saveAllowed} text={text} />
        </form>
      </dialog>
    </div>
  );
}

function SettingsValidation({ validation, text }: { validation: ReturnType<typeof validateSettingsDraft>; text: typeof copy.en }) {
  return <>
    {validation.autosaveDelayInvalid && <p className="settings-validation" role="alert">{text.autosaveDelayInvalid}</p>}
    {validation.fontSizeInvalid && <p className="settings-validation" role="alert">{text.fontSizeInvalid}</p>}
    {!validation.shortcutsValid && <p className="settings-validation" role="alert">{text.shortcutInvalid}</p>}
    {validation.shortcutConflicts.map(({ shortcut }) => <p className="settings-validation" role="alert" key={shortcut}>{text.shortcutConflict}: {shortcut}</p>)}
  </>;
}

// 对话框头：标题与关闭按钮。
function SettingsDialogHeader(props: { busy: boolean; buttonRef: React.Ref<HTMLButtonElement>; cancelLabel: string; onClose: () => void; title: string }) {
  return (
    <header className="settings-dialog-header">
      <div className="settings-dialog-heading"><Settings2 size={18} aria-hidden="true" /><h2 id="settings-dialog-title">{props.title}</h2></div>
      <button type="button" className="settings-dialog-close" ref={props.buttonRef} disabled={props.busy} aria-label={props.cancelLabel} title={props.cancelLabel} onClick={props.onClose}><X size={17} /></button>
    </header>
  );
}

function withResolvedShortcuts(value: AppSettings): AppSettings {
  return { ...value, shortcuts: resolveShortcutProfile(value.shortcuts) };
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
