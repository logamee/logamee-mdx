import type { LocalOpenIntentAction, LocalOpenIntentSource } from '../../lib/openIntent';
import type { EffectiveLocale } from '../../lib/locale';
import { isNativeSaveMenuEnabled } from '../../lib/nativeMenu';
import { useWorkspaceSearchActions } from './workspaceSearchActions';
import { useWorkspaceTreeOperations, type WorkspaceTreeOperationCommands } from './workspaceTreeOperations';
import { useAppWindowCommands, type AppWindowCommandTargets } from '../feedback/appWindowCommands';
import type { useWorkspaceUiStates } from './workspaceDialogStates';

export interface WorkspacePanelsDeps {
  activePath: string | null;
  editorFontSize: {
    increase: () => void;
    decrease: () => void;
    reset: () => void;
  };
  enqueueLocalOpenIntent: (source: LocalOpenIntentSource, displayPath: string, action: LocalOpenIntentAction) => void;
  handleClearRecent: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  isPopout: boolean;
  locale: EffectiveLocale;
  modalActive: boolean;
  onDismissSettings: () => void;
  onOpenSettings: () => void;
  openExportDialog: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  shortcutsConfig: Record<string, string>;
  session: WorkspacePanelsSession;
  translate: Parameters<typeof useWorkspaceSearchActions>[0]['translate'];
  uiStates: ReturnType<typeof useWorkspaceUiStates>;
  workspaceRollback: Parameters<typeof useWorkspaceTreeOperations>[0]['workspaceRollback'];
  workspaceToken: string | null;
}

// 工作区面板编排：搜索/索引动作、文件树操作与主窗命令面（原生菜单+快捷键）。
type WorkspacePanelsSession = WorkspaceTreeOperationCommands & {
  activeFileKind: Parameters<typeof isNativeSaveMenuEnabled>[0]['fileKind'];
  authorityStatus: Parameters<typeof isNativeSaveMenuEnabled>[0]['authorityStatus'];
  busy: boolean;
  externalFileAction: unknown;
  fileTree: import('../../lib/fileTree').WorkspaceFileTreeNode[];
  saveConflict: unknown;
  workspaceRoot: string | null;
};

function nativeSaveMenuEnabledFor(session: WorkspacePanelsSession): boolean {
  return isNativeSaveMenuEnabled({
    authorityStatus: session.authorityStatus,
    busy: session.busy || session.externalFileAction !== null || Boolean(session.saveConflict),
    fileKind: session.activeFileKind });
}

export function useAppWorkspacePanels(deps: WorkspacePanelsDeps) {
  const search = useWorkspaceSearchActions({
    enqueueLocalOpenIntent: deps.enqueueLocalOpenIntent as never,
    locale: deps.locale,
    modalActive: deps.modalActive,
    onDismissSettings: deps.onDismissSettings,
    setError: deps.setError,
    setNotice: deps.setNotice,
    states: deps.uiStates,
    translate: deps.translate,
    workspaceRoot: deps.session.workspaceRoot,
    workspaceToken: deps.workspaceToken });
  const tree = useWorkspaceTreeOperations({
    activePath: deps.activePath,
    fileTree: deps.session.fileTree,
    locale: deps.locale,
    session: deps.session,
    states: deps.uiStates,
    workspaceRollback: deps.workspaceRollback,
    workspaceRoot: deps.session.workspaceRoot });
  useAppWindowCommands({
    isPopout: deps.isPopout,
    locale: deps.locale,
    modalActive: deps.modalActive,
    nativeSaveMenuEnabled: nativeSaveMenuEnabledFor(deps.session),
    setError: deps.setError,
    setNotice: deps.setNotice,
    shortcutsConfig: deps.shortcutsConfig,
    targets: windowCommandTargets(deps, search.showWorkspaceSearchDialog) });

  return { search, tree };
}

function windowCommandTargets(
  deps: WorkspacePanelsDeps,
  showWorkspaceSearchDialog: (mode: 'quick-open' | 'workspace-search') => void,
): AppWindowCommandTargets {
  return {
    clearRecentFiles: deps.handleClearRecent,
    decreaseEditorFont: deps.editorFontSize.decrease,
    enqueueNativeMenuIntent: (displayPathZh: string, displayPathEn: string, action: Parameters<AppWindowCommandTargets['enqueueNativeMenuIntent']>[2]) => deps.enqueueLocalOpenIntent(
      'native_menu',
      deps.locale === 'zh-CN' ? displayPathZh : displayPathEn,
      action as never),
    increaseEditorFont: deps.editorFontSize.increase,
    openExportDialog: deps.openExportDialog,
    openSettings: deps.onOpenSettings,
    resetEditorFont: deps.editorFontSize.reset,
    save: deps.handleSave,
    saveAs: deps.handleSaveAs,
    showQuickOpen: () => showWorkspaceSearchDialog('quick-open'),
    showWorkspaceSearch: () => showWorkspaceSearchDialog('workspace-search') };
}
