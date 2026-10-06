import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import { APP_FEEDBACK_ERROR_EVENT } from '../../lib/appFeedback';
import {
  decodeNativeMenuCommand,
  NATIVE_MENU_EVENT } from '../../lib/nativeMenu';
import { setNativeSaveMenuEnabled } from '../../lib/tauriCommands';
import {
  resolveShortcutProfile,
  shortcutMatchesEvent,
  type ShortcutAction } from '../../lib/shortcutProfiles';

export interface AppWindowCommandTargets {
  clearRecentFiles: () => Promise<void>;
  enqueueNativeMenuIntent: (
    displayPathZh: string,
    displayPathEn: string,
    action:
      | { kind: 'new_document' }
      | { kind: 'open_file' }
      | { kind: 'open_directory' }
      | { kind: 'open_recent'; entryId: string },
  ) => void;
  increaseEditorFont: () => void;
  decreaseEditorFont: () => void;
  resetEditorFont: () => void;
  openExportDialog: () => void;
  openSettings: () => void;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  showQuickOpen: () => void;
  showWorkspaceSearch: () => void;
}

// 主窗口命令面：原生菜单事件、全局快捷键、反馈错误监听与原生保存菜单同步。
// 字号快捷键与保存同级：编辑器输入过程中直接可用，且在弹出编辑器窗口也生效
//（字号设置经设置事件跨窗口同步）；其余动作维持仅主窗口。
export interface AppWindowCommandDeps {
  isPopout: boolean;
  locale: EffectiveLocale;
  modalActive: boolean;
  nativeSaveMenuEnabled: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  shortcutsConfig: Record<string, string>;
  targets: AppWindowCommandTargets;
}

export function useAppWindowCommands(deps: AppWindowCommandDeps) {
  useAppFeedbackErrorEvents(deps);
  useNativeSaveMenuSync(deps.isPopout, deps.locale, deps.nativeSaveMenuEnabled, deps.setError, deps.setNotice);
  useNativeMenuCommands(deps);
  useAppKeyboardShortcuts(deps);
}

function useAppFeedbackErrorEvents(deps: {
  isPopout: boolean;
  locale: EffectiveLocale;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}): void {
  const { setError, setNotice } = deps;
  useEffect(() => {
    const handleFeedbackError = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        setError(event.detail);
        setNotice(null);
      }
    };
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, handleFeedbackError);
    return () => window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, handleFeedbackError);
  }, [setError, setNotice]);

  useEffect(() => {
    if (deps.isPopout) return undefined;
    let disposed = false;
    let unlistenFeedback: (() => void) | undefined;
    listen<string>(APP_FEEDBACK_ERROR_EVENT, (event) => {
      setError(normalizeAppError(event.payload, deps.locale));
      setNotice(null);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenFeedback = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err, deps.locale)));
    return () => {
      disposed = true;
      unlistenFeedback?.();
    };
  }, [deps.isPopout, deps.locale, setError, setNotice]);
}

function useNativeSaveMenuSync(
  isPopout: boolean,
  locale: EffectiveLocale,
  nativeSaveMenuEnabled: boolean,
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
): void {
  useEffect(() => {
    if (isPopout) return undefined;
    let current = true;
    const update = nativeSaveMenuSyncChain.current
      .catch(() => undefined)
      .then(() => setNativeSaveMenuEnabled(nativeSaveMenuEnabled));
    nativeSaveMenuSyncChain.current = update;
    void update.catch((err: unknown) => {
      if (!current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
    return () => {
      current = false;
    };
  }, [isPopout, locale, nativeSaveMenuEnabled, setError, setNotice]);
}

const nativeSaveMenuSyncChain: { current: Promise<void> } = { current: Promise.resolve() };

type NativeOpenIntent = Parameters<AppWindowCommandTargets['enqueueNativeMenuIntent']>[2];

const NATIVE_MENU_OPEN_INTENTS: Record<string, [string, string, NativeOpenIntent]> = {
  new: ['新建文档', 'New document', { kind: 'new_document' }],
  'open-file': ['选择文件', 'Choose a file', { kind: 'open_file' }],
  'open-directory': ['选择文件夹', 'Choose a folder', { kind: 'open_directory' }] };

function dispatchRecentFilesCommand(
  command: Extract<ReturnType<typeof decodeNativeMenuCommand>, { type: string }>,
  enqueueNativeMenuIntent: AppWindowCommandTargets['enqueueNativeMenuIntent'],
  targets: AppWindowCommandTargets,
): void {
  if (command.type === 'open-recent') {
    enqueueNativeMenuIntent('最近文档', 'Recent document', {
      kind: 'open_recent', entryId: command.entryId });
  } else {
    void targets.clearRecentFiles();
  }
}

function dispatchMenuTargetCommand(targets: AppWindowCommandTargets, command: string): void {
  if (command === 'quick-open') targets.showQuickOpen();
  else if (command === 'workspace-search') targets.showWorkspaceSearch();
  else if (command === 'save') void targets.save();
  else if (command === 'save-as') void targets.saveAs();
}

function dispatchNativeMenuCommand(
  command: ReturnType<typeof decodeNativeMenuCommand>,
  deps: AppWindowCommandDeps,
): void {
  const { enqueueNativeMenuIntent } = deps.targets;
  const { targets } = deps;
  if (typeof command === 'object') {
    if (command) dispatchRecentFilesCommand(command, enqueueNativeMenuIntent, targets);
    return;
  }
  if (!deps.nativeSaveMenuEnabled && (command === 'save' || command === 'save-as')) return;
  const intent = NATIVE_MENU_OPEN_INTENTS[command];
  if (intent) {
    enqueueNativeMenuIntent(intent[0], intent[1], intent[2]);
    return;
  }
  dispatchMenuTargetCommand(targets, command);
}

function useNativeMenuCommands(deps: Parameters<typeof useAppWindowCommands>[0]): void {
  const { setError } = deps;
  useEffect(() => {
    if (deps.isPopout) return undefined;
    let disposed = false;
    let unlistenNativeMenu: (() => void) | undefined;
    listen<unknown>(NATIVE_MENU_EVENT, (event) => {
      const command = decodeNativeMenuCommand(event.payload);
      if (!command) return;
      dispatchNativeMenuCommand(command, deps);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenNativeMenu = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err, deps.locale)));
    return () => {
      disposed = true;
      unlistenNativeMenu?.();
    };
  }, [deps, deps.isPopout, setError]);
}

type ShortcutProfile = ReturnType<typeof resolveShortcutProfile>;

function matchShortcutAction(
  shortcuts: ShortcutProfile,
  event: KeyboardEvent,
  isPopout: boolean,
  typing: boolean,
): ShortcutAction | null {
  const fontActions: ReadonlySet<ShortcutAction> = new Set([
    'editorFontLarger', 'editorFontSmaller', 'editorFontReset']);
  for (const action of Object.keys(shortcuts) as ShortcutAction[]) {
    if (isPopout && !fontActions.has(action)) continue;
    if (typing && action !== 'save' && action !== 'saveAs' && !fontActions.has(action)) continue;
    if (!shortcutMatchesEvent(shortcuts[action], event)) continue;
    return action;
  }
  return null;
}

function useAppKeyboardShortcuts(deps: Parameters<typeof useAppWindowCommands>[0]): void {
  const { targets } = deps;
  useEffect(() => {
    const shortcuts = resolveShortcutProfile(deps.shortcutsConfig);
    const actions: Record<ShortcutAction, () => void> = {
      save: () => void targets.save(),
      saveAs: () => void targets.saveAs(),
      quickOpen: targets.showQuickOpen,
      workspaceSearch: targets.showWorkspaceSearch,
      export: targets.openExportDialog,
      settings: targets.openSettings,
      editorFontLarger: targets.increaseEditorFont,
      editorFontSmaller: targets.decreaseEditorFont,
      editorFontReset: targets.resetEditorFont };
    const onKeyDown = (event: KeyboardEvent) => {
      if (deps.modalActive) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;
      const action = matchShortcutAction(shortcuts, event, deps.isPopout, typing);
      if (!action) return;
      event.preventDefault();
      actions[action]();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deps.isPopout, deps.modalActive, deps.shortcutsConfig, targets]);
}
