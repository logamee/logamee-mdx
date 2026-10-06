/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖数组保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { isEditableFileKind } from '../../lib/documentSession';
import type { PaneReplicatedState } from '../../lib/paneSync';
import type { AutosaveMode, FileVersion, WorkspaceFileKind } from '../../types';
import type { ExternalFileActionState, PendingDocumentSaveConflict } from './sessionTypes';

export interface AutosaveSessionDeps {
  activeFileKind: WorkspaceFileKind;
  activePath: string | null;
  activeFileVersionRef: RefObject<FileVersion | null>;
  autosaveBlockedContent: string | null;
  autosaveBlockedContentRef: RefObject<string | null>;
  autosaveDelayMs: number;
  autosaveEnabled: boolean;
  autosaveMode: AutosaveMode;
  authorityStatus: PaneReplicatedState['authorityStatus'];
  busy: boolean;
  busyRef: RefObject<boolean>;
  content: string;
  dirty: boolean;
  externalFileAction: ExternalFileActionState | null;
  externalFileActionRef: RefObject<ExternalFileActionState | null>;
  isPopout: boolean;
  paneStateRef: RefObject<PaneReplicatedState>;
  saveConflict: PendingDocumentSaveConflict | null;
  saveConflictRef: RefObject<PendingDocumentSaveConflict | null>;
  saveCurrentDocument: () => Promise<boolean>;
}

// 上下文门槛：非弹窗、启用自动保存、脏且有活动路径的可编辑文件类型。
function autosaveContextEligible(deps: AutosaveSessionDeps): boolean {
  return !deps.isPopout
    && deps.autosaveEnabled
    && deps.dirty
    && Boolean(deps.activePath)
    && isEditableFileKind(deps.activeFileKind);
}

// 状态门槛：权威已提交、版本可用且无外部动作/冲突/阻塞且空闲。
function autosaveStateClear(deps: AutosaveSessionDeps): boolean {
  return deps.authorityStatus === 'committed'
    && Boolean(deps.activeFileVersionRef.current)
    && deps.externalFileAction === null
    && deps.saveConflict === null
    && deps.autosaveBlockedContent !== deps.content
    && !deps.busy;
}

// 面板镜像状态是否可保存：可编辑类型 + 权威已提交。
function paneStateSaveable(state: PaneReplicatedState, version: FileVersion | null): boolean {
  return isEditableFileKind(state.activeFileKind)
    && (state.authorityStatus ?? 'unknown') === 'committed'
    && Boolean(version);
}

function useAutosaveCanRunNow(deps: AutosaveSessionDeps) {
  const { activeFileVersionRef, autosaveBlockedContentRef, busyRef, paneStateRef } = deps;
  const { externalFileActionRef, saveConflictRef } = deps;
  return useCallback(() => (
    autosaveContextEligible(deps)
    && paneStateSaveable(paneStateRef.current, activeFileVersionRef.current)
    && externalFileActionRef.current === null
    && saveConflictRef.current === null
    && autosaveBlockedContentRef.current !== paneStateRef.current.content
    && !busyRef.current
  ), [deps.activePath, deps.autosaveEnabled, deps.dirty, deps.isPopout]);
}

// “延时”保存：内容稳定超过 autosaveDelayMs（钳制 250ms~60s）后保存一次。
function useAutosaveAfterDelay(deps: AutosaveSessionDeps): void {
  const { activeFileVersionRef, autosaveDelayMs, autosaveMode, saveCurrentDocument } = deps;
  useEffect(() => {
    if (autosaveMode !== 'afterDelay') return undefined;
    if (!autosaveContextEligible(deps) || !autosaveStateClear(deps)) return undefined;
    const timer = globalThis.setTimeout(() => {
      void saveCurrentDocument();
    }, Math.max(250, Math.min(60_000, autosaveDelayMs)));
    return () => globalThis.clearTimeout(timer);
  }, [activeFileVersionRef, autosaveDelayMs, autosaveMode, saveCurrentDocument]);
}

// “切换窗口时”保存：应用窗口失去焦点（blur）即触发一次自动保存。
function useAutosaveOnWindowChange(deps: AutosaveSessionDeps, autosaveCanRunNow: () => boolean): void {
  const { autosaveMode, saveCurrentDocument } = deps;
  useEffect(() => {
    if (autosaveMode !== 'onWindowChange') return undefined;
    const handleBlur = () => {
      if (autosaveCanRunNow()) void saveCurrentDocument();
    };
    globalThis.addEventListener('blur', handleBlur);
    return () => globalThis.removeEventListener('blur', handleBlur);
  }, [autosaveCanRunNow, autosaveMode, saveCurrentDocument]);
}

// “失焦时”保存：键盘焦点离开编辑器区域（进入文件树、对话框或窗口外）即保存。
function useAutosaveOnFocusChange(deps: AutosaveSessionDeps, autosaveCanRunNow: () => boolean): void {
  const { autosaveMode, saveCurrentDocument } = deps;
  useEffect(() => {
    if (autosaveMode !== 'onFocusChange') return undefined;
    const handleFocusOut = (event: FocusEvent) => {
      const editorPane = document.querySelector('.editor-pane');
      if (!editorPane) return;
      const fromInside = event.target instanceof Node && editorPane.contains(event.target);
      const toInside = event.relatedTarget instanceof Node && editorPane.contains(event.relatedTarget);
      if (fromInside && !toInside && autosaveCanRunNow()) void saveCurrentDocument();
    };
    globalThis.addEventListener('focusout', handleFocusOut);
    return () => globalThis.removeEventListener('focusout', handleFocusOut);
  }, [autosaveCanRunNow, autosaveMode, saveCurrentDocument]);
}

// 自动保存会话：延时/窗口失焦/编辑器失焦三种模式统一经 canRunNow 门槛触发。
export function useAutosaveSession(deps: AutosaveSessionDeps): void {
  const autosaveCanRunNow = useAutosaveCanRunNow(deps);
  useAutosaveAfterDelay(deps);
  useAutosaveOnWindowChange(deps, autosaveCanRunNow);
  useAutosaveOnFocusChange(deps, autosaveCanRunNow);
}
