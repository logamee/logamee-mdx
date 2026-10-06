import { FolderOpen, RotateCcw } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../../types';
import type { EffectiveLocale } from '../../lib/locale';
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE } from '../../lib/settings';
import { SKINS } from '../../lib/theme';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
} from '../../lib/shortcutProfiles';
import type { SettingsDialogText } from './settingsDialogCopy';

type DraftProps = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings | null>>;
  text: SettingsDialogText;
};

// 自动保存、触发方式、延迟与拼写/双链开关。
export function SettingsAutosaveSection({ draft, setDraft, text }: DraftProps) {
  return (
    <section className="settings-section">
      <label className="settings-toggle"><span>{text.autosave}</span><input name="autosaveEnabled" type="checkbox" checked={draft.autosaveEnabled} onChange={(event) => setDraft({ ...draft, autosaveEnabled: event.target.checked })} /></label>
      <label className="settings-field"><span>{text.autosaveMode}</span><select name="autosaveMode" value={draft.autosaveMode} onChange={(event) => setDraft({ ...draft, autosaveMode: event.target.value as AppSettings['autosaveMode'] })}>
        <option value="afterDelay">{text.autosaveModeAfterDelay}</option>
        <option value="onFocusChange">{text.autosaveModeOnFocusChange}</option>
        <option value="onWindowChange">{text.autosaveModeOnWindowChange}</option>
      </select></label>
      <label className="settings-field"><span>{text.autosaveDelay}</span><span className="settings-number"><input name="autosaveDelayMs" type="number" min="250" max="60000" step="250" value={draft.autosaveDelayMs} onChange={(event) => setDraft({ ...draft, autosaveDelayMs: Number(event.target.value) })} /><small>{text.milliseconds}</small></span></label>
      <label className="settings-toggle"><span>{text.spellcheck}</span><input name="spellcheckEnabled" type="checkbox" checked={draft.spellcheckEnabled} onChange={(event) => setDraft({ ...draft, spellcheckEnabled: event.target.checked })} /></label>
      <label className="settings-toggle"><span>{text.wikilinks}</span><input name="wikilinksEnabled" type="checkbox" checked={draft.wikilinksEnabled} onChange={(event) => setDraft({ ...draft, wikilinksEnabled: event.target.checked })} /></label>
    </section>
  );
}

// 快捷键编辑：逐动作输入 + 冲突/非法提示。
export function SettingsShortcutsSection(props: DraftProps & {
  shortcutConflicts: { shortcut: string }[];
  shortcutsValid: boolean;
}) {
  const { draft, setDraft, text } = props;
  return (
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
      {!props.shortcutsValid && <p className="settings-validation" role="alert">{text.shortcutInvalid}</p>}
      {props.shortcutConflicts.map((conflict) => <p className="settings-validation" role="alert" key={conflict.shortcut}>{text.shortcutConflict}: {conflict.shortcut}</p>)}
    </section>
  );
}

// 资源文件夹与编辑区宽度。
export function SettingsResourceSection(props: DraftProps & {
  busy: boolean;
  onAuthorizeResourceDirectory?: () => Promise<string | null>;
}) {
  const { busy, draft, setDraft, text } = props;
  const authorize = async () => {
    const path = await props.onAuthorizeResourceDirectory?.();
    if (path) setDraft((current) => current ? { ...current, resourceDirectory: path } : current);
  };
  return (
    <section className="settings-section">
      <label className="settings-field">
        <span>{text.resources}</span>
        <span className="settings-path-control">
          <input name="resourceDirectory" type="text" value={draft.resourceDirectory} onChange={(event) => setDraft({ ...draft, resourceDirectory: event.target.value })} />
          <button
            type="button"
            name="authorizeResourceDirectory"
            className="settings-icon-button"
            disabled={busy || !props.onAuthorizeResourceDirectory}
            aria-label={text.chooseResources}
            title={text.chooseResources}
            onClick={() => void authorize()}
          >
            <FolderOpen size={16} aria-hidden="true" />
          </button>
        </span>
      </label>
      <label className="settings-field"><span>{text.layout}</span><input name="editorPaneRatio" type="range" min="0.25" max="0.75" step="0.01" value={draft.editorPaneRatio} onChange={(event) => setDraft({ ...draft, editorPaneRatio: Number(event.target.value) })} /></label>
    </section>
  );
}

// 皮肤选择、跟随系统、字号与语言。
export function SettingsAppearanceSection(props: DraftProps & { locale: EffectiveLocale }) {
  const { draft, locale, setDraft, text } = props;
  return (
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
      <label className="settings-field"><span>{text.editorFontSize}</span><span className="settings-number"><input name="editorFontSize" type="number" min={MIN_EDITOR_FONT_SIZE} max={MAX_EDITOR_FONT_SIZE} step="1" value={draft.editorFontSize} onChange={(event) => setDraft({ ...draft, editorFontSize: Number(event.target.value) })} /><small>{text.fontSizeUnit}</small></span></label>
      <label className="settings-field"><span>{text.language}</span><select name="localeMode" value={draft.localeMode} onChange={(event) => setDraft({ ...draft, localeMode: event.target.value as AppSettings['localeMode'] })}><option value="system">System</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
    </section>
  );
}

// 工作区索引管理（丢弃/重建）。
export function SettingsWorkspaceIndexSection(props: {
  busy: boolean;
  onDiscardWorkspaceIndex?: () => Promise<void>;
  onRebuildWorkspaceIndex?: () => Promise<void>;
  text: SettingsDialogText;
  workspaceAvailable: boolean;
}) {
  const { busy, text, workspaceAvailable } = props;
  return (
    <section className="settings-section" aria-labelledby="workspace-index-heading" aria-describedby="workspace-index-description">
      <h3 id="workspace-index-heading">{text.workspaceIndex}</h3>
      <p id="workspace-index-description">{workspaceAvailable ? text.workspaceIndexDescription : text.workspaceIndexUnavailable}</p>
      <div className="settings-index-actions">
        <button type="button" name="discardWorkspaceIndex" className="dialog-button ghost" disabled={busy || !workspaceAvailable || !props.onDiscardWorkspaceIndex} onClick={() => void props.onDiscardWorkspaceIndex?.()}>{text.discardIndex}</button>
        <button type="button" name="rebuildWorkspaceIndex" className="dialog-button secondary" disabled={busy || !workspaceAvailable || !props.onRebuildWorkspaceIndex} onClick={() => void props.onRebuildWorkspaceIndex?.()}>{text.rebuildIndex}</button>
      </div>
    </section>
  );
}

// 底部动作条：重置/取消/保存（校验不过或忙时禁用保存）。
export function SettingsDialogActions(props: {
  busy: boolean;
  cancel: () => void;
  onReset: () => void;
  saveAllowed: boolean;
  text: SettingsDialogText;
}) {
  const { busy, text } = props;
  return (
    <div className="settings-dialog-actions">
      <button type="button" className="dialog-button ghost" disabled={busy} onClick={() => void props.onReset()}><RotateCcw size={14} aria-hidden="true" />{text.reset}</button>
      <button type="button" className="dialog-button ghost" disabled={busy} onClick={props.cancel}>{text.cancel}</button>
      <button type="submit" className="dialog-button secondary" disabled={busy || !props.saveAllowed}>{text.save}</button>
    </div>
  );
}
