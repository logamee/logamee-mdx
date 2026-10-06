import { useState } from 'react';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { WorkspaceEntryOperation } from './WorkspaceEntryDialog';
import type { WorkspaceMoveOperation } from './WorkspaceMoveDialog';
import type { WorkspaceSearchMode } from './WorkspaceSearchDialog';

// 工作区 UI 对话框与树的共享状态：先于 openIntentModalActive 计算创建，
// 供模态互斥判断与各动作钩子（搜索/索引、树操作）共同消费。
export function useWorkspaceUiStates() {
  const [workspaceSearchMode, setWorkspaceSearchMode] = useState<WorkspaceSearchMode | null>(null);
  const [workspaceEntryOperation, setWorkspaceEntryOperation] = useState<WorkspaceEntryOperation | null>(null);
  const [workspaceMoveOperation, setWorkspaceMoveOperation] = useState<WorkspaceMoveOperation | null>(null);
  const [workspaceIndexActionBusy, setWorkspaceIndexActionBusy] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [fileTreeClipboard, setFileTreeClipboard] = useState<FileTreeClipboardItem | null>(null);
  return {
    collapsedFolders,
    fileTreeClipboard,
    setCollapsedFolders,
    setFileTreeClipboard,
    setWorkspaceEntryOperation,
    setWorkspaceIndexActionBusy,
    setWorkspaceMoveOperation,
    setWorkspaceSearchMode,
    workspaceEntryOperation,
    workspaceIndexActionBusy,
    workspaceMoveOperation,
    workspaceSearchMode };
}

export type WorkspaceUiStates = ReturnType<typeof useWorkspaceUiStates>;
