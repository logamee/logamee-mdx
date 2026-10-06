import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  FileType2,
  Film,
  Folder,
  FolderOpen,
  Image,
  Music2,
  PencilRuler,
} from 'lucide-react';
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import { getWorkspacePresentation } from '../../lib/workspaceFileKind';
import { useI18n } from '../../lib/i18n';
import type { WorkspaceFileKind } from '../../types';
import {
  handleTreeRowKeyDown,
  openMouseContextMenu,
  type FileTreeRowsProps,
  type WorkspaceTreeTarget,
} from './fileTreeRowInteractions';
import { commitTreeRowRename, TreeRowRenameInput, useTreeRowRenameFocus } from './fileTreeRowRename';
import { buildTreeRowState, treeRowClassNames } from './fileTreeRowState';

type FileTreeRowProps = Omit<FileTreeRowsProps, 'nodes'> & { node: WorkspaceFileTreeNode };

function WorkspaceFileIcon({ kind }: { kind: WorkspaceFileKind }) {
  const presentation = getWorkspacePresentation(kind);
  if (presentation.preview === 'image') return <Image className="tree-icon image-icon" size={15} />;
  if (presentation.preview === 'html') return <FileCode2 className="tree-icon html-icon" size={15} />;
  if (presentation.preview === 'excalidraw') return <PencilRuler className="tree-icon excalidraw-icon" size={15} />;
  if (presentation.preview === 'media' && presentation.media_kind === 'video') {
    return <Film className="tree-icon video-icon" size={15} />;
  }
  if (presentation.preview === 'media') return <Music2 className="tree-icon audio-icon" size={15} />;
  if (presentation.preview === 'pdf') return <FileType2 className="tree-icon pdf-icon" size={15} />;
  if (presentation.preview === 'docx') return <FileText className="tree-icon docx-icon" size={15} />;
  return <FileText className="tree-icon file-icon" size={15} />;
}

// 折叠开关与前置图标：文件夹显示开关按钮和开合图标，文件显示占位与类型图标。
function TreeRowLeading(props: {
  collapsed: boolean;
  contextTarget: WorkspaceTreeTarget;
  isFolder: boolean;
  node: WorkspaceFileTreeNode;
  onSelectTarget: FileTreeRowsProps['onSelectTarget'];
  onToggleFolder: FileTreeRowsProps['onToggleFolder'];
}) {
  const { t } = useI18n();
  const { collapsed, contextTarget, isFolder, node } = props;
  return (
    <>
      {isFolder ? (
        <button
          type="button"
          className="tree-disclosure-button"
          tabIndex={-1}
          aria-label={collapsed ? t('expandFolder', { name: node.name }) : t('collapseFolder', { name: node.name })}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelectTarget(contextTarget);
            props.onToggleFolder(node.path);
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : <span className="tree-chevron-spacer" aria-hidden="true" />}
      {isFolder
        ? collapsed
          ? <Folder className="tree-icon folder-icon" size={16} />
          : <FolderOpen className="tree-icon folder-icon open" size={16} />
        : <WorkspaceFileIcon kind={(node as Extract<WorkspaceFileTreeNode, { kind: 'file' }>).file.kind} />}
    </>
  );
}

// 子级分支容器：以 fieldset 承载缩进参考线并递归渲染下一层。
function TreeBranchChildren(props: FileTreeRowProps & { absolutePath: string; collapsed: boolean }) {
  const { absolutePath, collapsed, depth = 0 } = props;
  if (props.node.kind !== 'folder' || collapsed) return null;
  return (
    <fieldset
      className="tree-branch-children"
      data-tree-parent-path={absolutePath}
      style={{ '--branch-guide-left': `${15 + depth * 16}px` } as CSSProperties}
    >
      <FileTreeRows
        activePath={props.activePath}
        collapsedFolders={props.collapsedFolders}
        depth={depth + 1}
        disabled={props.disabled}
        draggingPath={props.draggingPath}
        dropTargetPath={props.dropTargetPath}
        nodes={props.node.children}
        onBeginRename={props.onBeginRename}
        onCancelRename={props.onCancelRename}
        onCommitRename={props.onCommitRename}
        onDeleteEntry={props.onDeleteEntry}
        onOpenContextMenu={props.onOpenContextMenu}
        onOpenFile={props.onOpenFile}
        onSelectTarget={props.onSelectTarget}
        onToggleFolder={props.onToggleFolder}
        renamingPath={props.renamingPath}
        selectedPath={props.selectedPath}
      />
    </fieldset>
  );
}

// 树行容器：aria 树语义、拖拽/选中样式与点击/右键/双击/键盘入口。
function TreeRowContainer(props: {
  children: React.ReactNode;
  depth: number;
  disabled: boolean;
  draggingPath: string | null;
  dropTargetPath: string | null;
  node: WorkspaceFileTreeNode;
  rowState: ReturnType<typeof buildTreeRowState>;
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'];
  onOpenFile: FileTreeRowsProps['onOpenFile'];
  onSelectTarget: FileTreeRowsProps['onSelectTarget'];
  onToggleFolder: FileTreeRowsProps['onToggleFolder'];
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { depth, disabled, draggingPath, dropTargetPath, node, rowState } = props;
  const { absolutePath, active, collapsed, contextTarget, isFolder, isRenaming, selected } = rowState;
  return (
    <div
      role="treeitem"
      tabIndex={selected ? 0 : -1}
      aria-current={active ? 'page' : undefined}
      aria-expanded={isFolder ? !collapsed : undefined}
      aria-disabled={disabled || undefined}
      aria-level={depth + 1}
      aria-selected={selected}
      className={treeRowClassNames({
        absolutePath, active, contextTargetPath: contextTarget.path, disabled,
        draggingPath, dropTargetPath, isFolder, isRenaming, selected, })}
      data-context-menu-target={contextTarget.kind}
      data-tree-entry-path={contextTarget.path} draggable={false}
      style={{ paddingLeft: 8 + depth * 16 }} title={contextTarget.path}
      onClick={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        props.onSelectTarget(contextTarget);
        if (!disabled && contextTarget.kind === 'file') props.onOpenFile(contextTarget.path);
      }}
      onContextMenu={(event) => {
        if (disabled) event.preventDefault();
        else openMouseContextMenu(event, contextTarget, props.onOpenContextMenu);
      }}
      onDoubleClick={() => {
        if (contextTarget.kind === 'folder') props.onToggleFolder(node.path); }}
      onFocus={() => props.onSelectTarget(contextTarget)}
      onKeyDown={props.handleKeyDown}>{props.children}</div>
  );
}

function FileTreeRow(props: FileTreeRowProps) {
  const { activePath, collapsedFolders, depth = 0, disabled = false, draggingPath, dropTargetPath, node } = props;
  const { onBeginRename, onCancelRename, onCommitRename, onDeleteEntry, onOpenContextMenu } = props;
  const { onOpenFile, onSelectTarget, onToggleFolder, renamingPath, selectedPath } = props;
  const { t } = useI18n();
  const rowState = buildTreeRowState({ activePath, collapsedFolders, node, renamingPath, selectedPath });
  const { absolutePath, collapsed, contextTarget, isRenaming } = rowState;
  const [draftName, setDraftName] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameFinishedRef = useRef(false);

  useTreeRowRenameFocus({ contextTarget, isRenaming, node, renameInputRef, renameFinishedRef, setDraftName });
  const commitRename = () => {
    commitTreeRowRename({ contextTarget, draftName, node, onCancelRename, onCommitRename, renameFinishedRef });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    handleTreeRowKeyDown(event, {
      collapsed, contextTarget, disabled, node,
      onBeginRename, onDeleteEntry, onOpenContextMenu, onOpenFile, onToggleFolder,
    });
  };

  return (
    <>
      <TreeRowContainer
        depth={depth} disabled={disabled} draggingPath={draggingPath} dropTargetPath={dropTargetPath}
        node={node} rowState={rowState} onOpenContextMenu={onOpenContextMenu} onOpenFile={onOpenFile}
        onSelectTarget={onSelectTarget} onToggleFolder={onToggleFolder} handleKeyDown={handleKeyDown}>
        <TreeRowLeading
          collapsed={collapsed} contextTarget={contextTarget} isFolder={rowState.isFolder}
          node={node} onSelectTarget={onSelectTarget} onToggleFolder={onToggleFolder} />
        {isRenaming ? (
          <TreeRowRenameInput
            draftName={draftName} node={node} renameInputRef={renameInputRef} setDraftName={setDraftName}
            onCancelRename={onCancelRename} commitRename={commitRename} renameFinishedRef={renameFinishedRef} />
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
        {rowState.active && <span className="tree-open-indicator" title={t('openDocument')} aria-label={t('openDocument')} />}
      </TreeRowContainer>
      <TreeBranchChildren {...props} absolutePath={absolutePath} collapsed={collapsed} />
    </>
  );
}

export function FileTreeRows(props: FileTreeRowsProps) {
  return props.nodes.map((node) => (
    <FileTreeRow key={node.absolutePath} {...props} node={node} />
  ));
}
