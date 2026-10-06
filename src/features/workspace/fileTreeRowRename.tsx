/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：聚焦效果依赖保持提取前原样 */
import { useEffect } from 'react';
import { useI18n } from '../../lib/i18n';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { WorkspaceTreeTarget } from './fileTreeRowInteractions';

export function TreeRowRenameInput({
  draftName,
  node,
  renameInputRef,
  setDraftName,
  onCancelRename,
  commitRename,
  renameFinishedRef,
}: {
  draftName: string;
  node: { name: string };
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  setDraftName: (name: string) => void;
  onCancelRename: () => void;
  commitRename: () => void;
  renameFinishedRef: React.RefObject<boolean>;
}) {
  const { t } = useI18n();
  return (
    <input
      ref={renameInputRef}
      className="tree-inline-rename"
      value={draftName}
      aria-label={t('renameItem', { name: node.name })}
      onBlur={commitRename}
      onChange={(event) => setDraftName(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitRename();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          renameFinishedRef.current = true;
          onCancelRename();
        }
      }}
    />
  );
}

// 重命名聚焦：进入重命名时填入原名、聚焦并按类型选中文件名（不含扩展名）。
export function useTreeRowRenameFocus(deps: {
  contextTarget: WorkspaceTreeTarget;
  isRenaming: boolean;
  node: WorkspaceFileTreeNode;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameFinishedRef: React.RefObject<boolean>;
  setDraftName: (name: string) => void;
}): void {
  const { contextTarget, isRenaming, node, renameInputRef, renameFinishedRef, setDraftName } = deps;
  useEffect(() => {
    if (!isRenaming) return;
    renameFinishedRef.current = false;
    setDraftName(node.name);
    const focusInput = () => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      const extensionStart = contextTarget.kind === 'file' ? node.name.lastIndexOf('.') : -1;
      input.setSelectionRange(0, extensionStart > 0 ? extensionStart : node.name.length);
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(focusInput);
      return () => cancelAnimationFrame(frame);
    }
    const timeout = window.setTimeout(focusInput, 0);
    return () => window.clearTimeout(timeout);
  }, [contextTarget.kind, isRenaming, node.name]);
}

// 提交重命名：空名或未变化视为取消；重复提交（blur + Enter）只生效一次。
export function commitTreeRowRename(deps: {
  contextTarget: WorkspaceTreeTarget;
  draftName: string;
  node: WorkspaceFileTreeNode;
  onCancelRename: () => void;
  onCommitRename: (target: WorkspaceTreeTarget, name: string) => void;
  renameFinishedRef: React.RefObject<boolean>;
}): void {
  if (deps.renameFinishedRef.current) return;
  deps.renameFinishedRef.current = true;
  const nextName = deps.draftName.trim();
  if (!nextName || nextName === deps.node.name) {
    deps.onCancelRename();
    return;
  }
  deps.onCommitRename(deps.contextTarget, nextName);
}
