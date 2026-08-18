import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen, RotateCcw, Settings2, X } from 'lucide-react';
import type { AppSettings } from '../types';
import type { EffectiveLocale } from '../lib/locale';
import type { SettingsRecovery } from '../hooks/useSettings';
import { SKINS } from '../lib/theme';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  resolveShortcutProfile,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
} from '../lib/shortcutProfiles';

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

const copy = {
  en: {
    title: 'Settings', autosave: 'Autosave', autosaveDelay: 'Save delay', milliseconds: 'ms',
    spellcheck: 'Spellcheck', wikilinks: 'Wikilinks', resources: 'Resource folder', layout: 'Editor width',
    appearance: 'Appearance', skin: 'Theme', followSystem: 'Follow system theme', language: 'Language',
    save: 'Save', cancel: 'Cancel', reset: 'Reset Settings', retry: 'Try Again',
    recoveryTitle: 'Settings Could Not Be Loaded',
    recoveryMessage: 'The saved settings are unavailable or incompatible. Retry, or reset them to verified defaults.',
    futureTitle: 'Settings Require a Newer mdx Version',
    futureMessage: 'These settings were created by a newer version and were left unchanged. Upgrade mdx, then try again.',
    conflictTitle: 'Settings Changed Elsewhere',
    conflictMessage: 'Settings changed in another window. Reload the latest settings before making changes.',
    reload: 'Reload Settings',
    workspaceIndex: 'Workspace Index',
    workspaceIndexDescription: 'Manage the local index used to search workspace files.',
    workspaceIndexUnavailable: 'Open a workspace to manage its index.',
    discardIndex: 'Discard index',
    rebuildIndex: 'Rebuild index',
    chooseResources: 'Choose resource folder',
    shortcuts: 'Keyboard Shortcuts', resetShortcuts: 'Restore shortcut defaults',
    shortcutConflict: 'Shortcut conflict', shortcutInvalid: 'Enter a supported shortcut.',
    shortcutLabels: { save: 'Save', saveAs: 'Save as', quickOpen: 'Quick open', workspaceSearch: 'Workspace search', export: 'Export', settings: 'Settings' },
  },
  'zh-CN': {
    title: '设置', autosave: '自动保存', autosaveDelay: '保存延迟', milliseconds: '毫秒',
    spellcheck: '拼写检查', wikilinks: '双向链接', resources: '资源文件夹', layout: '编辑区宽度',
    appearance: '外观', skin: '主题', followSystem: '跟随系统主题', language: '语言',
    save: '保存', cancel: '取消', reset: '重置设置', retry: '重试',
    recoveryTitle: '无法加载设置',
    recoveryMessage: '已保存的设置不可用或不兼容。请重试，或将设置重置为已验证的默认值。',
    futureTitle: '设置需要更新版本的 mdx',
    futureMessage: '这些设置由更新版本创建，文件未被修改。请升级 mdx 后重试。',
    conflictTitle: '设置已在其他窗口更改',
    conflictMessage: '设置已在其他窗口更新。请先重新加载最新设置，再继续修改。',
    reload: '重新加载设置',
    workspaceIndex: '工作区索引',
    workspaceIndexDescription: '管理用于搜索工作区文件的本地索引。',
    workspaceIndexUnavailable: '请先打开工作区，再管理其索引。',
    discardIndex: '丢弃索引',
    rebuildIndex: '重建索引',
    chooseResources: '选择资源文件夹',
    shortcuts: '键盘快捷键', resetShortcuts: '恢复默认快捷键',
    shortcutConflict: '快捷键冲突', shortcutInvalid: '请输入受支持的快捷键。',
    shortcutLabels: { save: '保存', saveAs: '另存为', quickOpen: '快速打开', workspaceSearch: '工作区搜索', export: '导出', settings: '设置' },
  },
};

export function SettingsDialog({
  busy,
  locale,
  settings,
  recovery = null,
  onClose,
  onReset,
  onRetry,
  onSave,
  onAuthorizeResourceDirectory,
  workspaceAvailable = false,
  onDiscardWorkspaceIndex,
  onRebuildWorkspaceIndex,
}: SettingsDialogProps) {
  const text = copy[locale];
  const withResolvedShortcuts = (value: AppSettings | null | undefined) => value
    ? { ...value, shortcuts: resolveShortcutProfile(value.shortcuts) }
    : null;
  const [draft, setDraft] = useState<AppSettings | null>(() => withResolvedShortcuts(settings));
  useEffect(() => setDraft(withResolvedShortcuts(settings)), [settings]);

  if (recovery) {
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

  if (!draft || !onSave || !onClose) return null;

  let shortcutConflicts = [] as ReturnType<typeof findShortcutConflicts>;
  let shortcutsValid = true;
  try {
    shortcutConflicts = findShortcutConflicts(draft.shortcuts);
  } catch {
    shortcutsValid = false;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave({ ...draft, shortcuts: resolveShortcutProfile(draft.shortcuts) });
  };

  const authorizeResourceDirectory = async () => {
    const path = await onAuthorizeResourceDirectory?.();
    if (path) setDraft((current) => current ? { ...current, resourceDirectory: path } : current);
  };

  return (
    <div className="settings-dialog-backdrop">
      <dialog open className="settings-dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <form onSubmit={submit}>
          <header className="settings-dialog-header">
            <div className="settings-dialog-heading"><Settings2 size={18} aria-hidden="true" /><h2 id="settings-dialog-title">{text.title}</h2></div>
            <button type="button" className="settings-dialog-close" aria-label={text.cancel} title={text.cancel} onClick={onClose}><X size={17} /></button>
          </header>

          <section className="settings-section">
            <label className="settings-toggle"><span>{text.autosave}</span><input name="autosaveEnabled" type="checkbox" checked={draft.autosaveEnabled} onChange={(event) => setDraft({ ...draft, autosaveEnabled: event.target.checked })} /></label>
            <label className="settings-field"><span>{text.autosaveDelay}</span><span className="settings-number"><input name="autosaveDelayMs" type="number" min="250" max="60000" step="250" value={draft.autosaveDelayMs} onChange={(event) => setDraft({ ...draft, autosaveDelayMs: Number(event.target.value) })} /><small>{text.milliseconds}</small></span></label>
            <label className="settings-toggle"><span>{text.spellcheck}</span><input name="spellcheckEnabled" type="checkbox" checked={draft.spellcheckEnabled} onChange={(event) => setDraft({ ...draft, spellcheckEnabled: event.target.checked })} /></label>
            <label className="settings-toggle"><span>{text.wikilinks}</span><input name="wikilinksEnabled" type="checkbox" checked={draft.wikilinksEnabled} onChange={(event) => setDraft({ ...draft, wikilinksEnabled: event.target.checked })} /></label>
          </section>

          <section className="settings-section" aria-labelledby="settings-shortcuts-heading">
            <div className="settings-section-heading">
              <h3 id="settings-shortcuts-heading">{text.shortcuts}</h3>
              <button type="button" name="resetShortcuts" className="settings-icon-button" title={text.resetShortcuts} aria-label={text.resetShortcuts} onClick={() => setDraft({ ...draft, shortcuts: { ...DEFAULT_SHORTCUTS } })}><RotateCcw size={15} aria-hidden="true" /></button>
            </div>
            {SHORTCUT_ACTIONS.map((action) => (
              <label className="settings-field" key={action}>
                <span>{text.shortcutLabels[action as ShortcutAction]}</span>
                <input name={`shortcut-${action}`} type="text" value={draft.shortcuts[action] ?? ''} onChange={(event) => setDraft({ ...draft, shortcuts: { ...draft.shortcuts, [action]: event.target.value } })} />
              </label>
            ))}
            {!shortcutsValid && <p className="settings-validation" role="alert">{text.shortcutInvalid}</p>}
            {shortcutConflicts.map((conflict) => <p className="settings-validation" role="alert" key={conflict.shortcut}>{text.shortcutConflict}: {conflict.shortcut}</p>)}
          </section>

          <section className="settings-section">
            <label className="settings-field">
              <span>{text.resources}</span>
              <span className="settings-path-control">
                <input name="resourceDirectory" type="text" value={draft.resourceDirectory} onChange={(event) => setDraft({ ...draft, resourceDirectory: event.target.value })} />
                <button
                  type="button"
                  name="authorizeResourceDirectory"
                  className="settings-icon-button"
                  disabled={busy || !onAuthorizeResourceDirectory}
                  aria-label={text.chooseResources}
                  title={text.chooseResources}
                  onClick={() => void authorizeResourceDirectory()}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                </button>
              </span>
            </label>
            <label className="settings-field"><span>{text.layout}</span><input name="editorPaneRatio" type="range" min="0.25" max="0.75" step="0.01" value={draft.editorPaneRatio} onChange={(event) => setDraft({ ...draft, editorPaneRatio: Number(event.target.value) })} /></label>
          </section>

          <section className="settings-section">
            <h3>{text.appearance}</h3>
            <fieldset className="settings-skin-picker" role="radiogroup">
              <legend>{text.skin}</legend>
              <div className="settings-skin-grid">
                {SKINS.map((skin) => {
                  const swatches = skin.tokens
                    ? [skin.tokens.panel, skin.tokens.chromeText, skin.tokens.accent, skin.tokens.panelMuted]
                    : skin.swatches.light;
                  const selected = draft.selectedSkin === skin.id;
                  return (
                    <label className={`settings-skin-option${selected ? ' selected' : ''}`} key={skin.id}>
                      <input
                        type="radio"
                        name="selectedSkin"
                        value={skin.id}
                        checked={selected}
                        onChange={() => setDraft({ ...draft, selectedSkin: skin.id })}
                      />
                      <span className="settings-skin-swatches" aria-hidden="true">
                        {swatches.map((color, index) => (
                          <span key={`${skin.id}-${index}`} style={{ backgroundColor: color }} />
                        ))}
                      </span>
                      <span className="settings-skin-name">{locale === 'zh-CN' ? skin.nameZh : skin.nameEn}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="settings-toggle"><span>{text.followSystem}</span><input name="followSystemTheme" type="checkbox" checked={draft.followSystemTheme} onChange={(event) => setDraft({ ...draft, followSystemTheme: event.target.checked })} /></label>
            <label className="settings-field"><span>{text.language}</span><select name="localeMode" value={draft.localeMode} onChange={(event) => setDraft({ ...draft, localeMode: event.target.value as AppSettings['localeMode'] })}><option value="system">System</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
          </section>

          <section className="settings-section" aria-labelledby="workspace-index-heading" aria-describedby="workspace-index-description">
            <h3 id="workspace-index-heading">{text.workspaceIndex}</h3>
            <p id="workspace-index-description">{workspaceAvailable ? text.workspaceIndexDescription : text.workspaceIndexUnavailable}</p>
            <div className="settings-index-actions">
              <button type="button" name="discardWorkspaceIndex" className="dialog-button ghost" disabled={busy || !workspaceAvailable || !onDiscardWorkspaceIndex} onClick={() => void onDiscardWorkspaceIndex?.()}>{text.discardIndex}</button>
              <button type="button" name="rebuildWorkspaceIndex" className="dialog-button secondary" disabled={busy || !workspaceAvailable || !onRebuildWorkspaceIndex} onClick={() => void onRebuildWorkspaceIndex?.()}>{text.rebuildIndex}</button>
            </div>
          </section>

          <div className="settings-dialog-actions">
            <button type="button" className="dialog-button ghost" disabled={busy} onClick={() => void onReset()}><RotateCcw size={14} aria-hidden="true" />{text.reset}</button>
            <button type="button" className="dialog-button ghost" disabled={busy} onClick={onClose}>{text.cancel}</button>
            <button type="submit" className="dialog-button secondary" disabled={busy || !shortcutsValid || shortcutConflicts.length > 0}>{text.save}</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
