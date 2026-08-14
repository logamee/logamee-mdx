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
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  canRenameFileTreeTarget,
  type FileTreeContextTarget,
} from '../lib/fileTreeContextMenu';
import type { WorkspaceFileTreeNode } from '../lib/fileTree';
import { getWorkspacePresentation } from '../lib/workspaceFileKind';
import { useI18n } from '../lib/i18n';
import type { WorkspaceFileKind } from '../types';

type WorkspaceTreeTarget = Exclude<FileTreeContextTarget, { kind: 'root' }>;

interface FileTreeRowsProps {
  activePath: string | null;
  collapsedFolders: Set<string>;
  depth?: number;
  disabled?: boolean;
  draggingPath: string | null;
  dropTargetPath: string | null;
  nodes: WorkspaceFileTreeNode[];
  onBeginRename: (target: WorkspaceTreeTarget) => void;
  onCancelRename: () => void;
  onCommitRename: (target: WorkspaceTreeTarget, name: string) => void;
  onDeleteEntry: (target: WorkspaceTreeTarget) => void;
  onOpenContextMenu: (x: number, y: number, target: FileTreeContextTarget) => void;
  onOpenFile: (path: string) => void;
  onSelectTarget: (target: WorkspaceTreeTarget) => void;
  onToggleFolder: (path: string) => void;
  renamingPath: string | null;
  selectedPath: string | null;
}

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

function openMouseContextMenu(
  event: MouseEvent,
  target: FileTreeContextTarget,
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'],
) {
  event.preventDefault();
  event.stopPropagation();
  onOpenContextMenu(event.clientX, event.clientY, target);
}

function openKeyboardContextMenu(
  event: KeyboardEvent<HTMLElement>,
  target: FileTreeContextTarget,
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'],
) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  onOpenContextMenu(rect.left + 20, rect.bottom + 4, target);
  return true;
}

interface FileTreeRowProps extends Omit<FileTreeRowsProps, 'nodes'> {
  node: WorkspaceFileTreeNode;
}

function FileTreeRow({
  activePath,
  collapsedFolders,
  depth = 0,
  disabled = false,
  draggingPath,
  dropTargetPath,
  node,
  onBeginRename,
  onCancelRename,
  onCommitRename,
  onDeleteEntry,
  onOpenContextMenu,
  onOpenFile,
  onSelectTarget,
  onToggleFolder,
  renamingPath,
  selectedPath,
}: FileTreeRowProps) {
  const { t } = useI18n();
  const isFolder = node.kind === 'folder';
  const absolutePath = node.absolutePath;
  const contextTarget: WorkspaceTreeTarget = isFolder
    ? { kind: 'folder', name: node.name, path: absolutePath }
    : {
      fileKind: node.file.kind,
      kind: 'file',
      name: node.name,
      path: node.path,
    };
  const isRenaming = renamingPath === contextTarget.path;
  const selected = selectedPath === contextTarget.path;
  const active = !isFolder && node.path === activePath;
  const collapsed = isFolder && collapsedFolders.has(node.path);
  const [draftName, setDraftName] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameFinishedRef = useRef(false);

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

  const commitRename = () => {
    if (renameFinishedRef.current) return;
    renameFinishedRef.current = true;
    const nextName = draftName.trim();
    if (!nextName || nextName === node.name) {
      onCancelRename();
      return;
    }
    onCommitRename(contextTarget, nextName);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (disabled) return;
    if (openKeyboardContextMenu(event, contextTarget, onOpenContextMenu)) return;

    if ((event.key === 'Enter' || event.key === 'F2') && canRenameFileTreeTarget(contextTarget)) {
      event.preventDefault();
      onBeginRename(contextTarget);
      return;
    }
    if (event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      onDeleteEntry(contextTarget);
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === 'o' && contextTarget.kind === 'file') {
      event.preventDefault();
      onOpenFile(contextTarget.path);
      return;
    }
    if (event.key === ' ' && contextTarget.kind === 'file') {
      event.preventDefault();
      onOpenFile(contextTarget.path);
      return;
    }
    if (contextTarget.kind === 'folder' && event.key === 'ArrowRight' && collapsed) {
      event.preventDefault();
      onToggleFolder(node.path);
      return;
    }
    if (contextTarget.kind === 'folder' && event.key === 'ArrowLeft' && !collapsed) {
      event.preventDefault();
      onToggleFolder(node.path);
    }
  };

  const rowClassNames = [
    'tree-row',
    'tree-row-main',
    isFolder ? 'folder-row' : 'file-row',
    selected ? 'selected' : '',
    active ? 'active-document' : '',
    disabled ? 'disabled' : '',
    draggingPath === contextTarget.path ? 'dragging' : '',
    isFolder && dropTargetPath === absolutePath ? 'drop-target' : '',
    isRenaming ? 'renaming' : '',
  ].filter(Boolean).join(' ');
  const rowStyle = { paddingLeft: 8 + depth * 16 };

  return (
    <>
      <div
        role="treeitem"
        tabIndex={selected ? 0 : -1}
        aria-current={active ? 'page' : undefined}
        aria-expanded={isFolder ? !collapsed : undefined}
        aria-disabled={disabled || undefined}
        aria-level={depth + 1}
        aria-selected={selected}
        className={rowClassNames}
        data-context-menu-target={contextTarget.kind}
        data-tree-entry-path={contextTarget.path}
        draggable={false}
        style={rowStyle}
        title={contextTarget.path}
        onClick={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          onSelectTarget(contextTarget);
          if (!disabled && contextTarget.kind === 'file') onOpenFile(contextTarget.path);
        }}
        onContextMenu={(event) => {
          if (disabled) event.preventDefault();
          else openMouseContextMenu(event, contextTarget, onOpenContextMenu);
        }}
        onDoubleClick={() => {
          if (contextTarget.kind === 'folder') onToggleFolder(node.path);
        }}
        onFocus={() => onSelectTarget(contextTarget)}
        onKeyDown={handleKeyDown}
      >
        {isFolder ? (
          <button
            type="button"
            className="tree-disclosure-button"
            tabIndex={-1}
            aria-label={collapsed ? t('expandFolder', { name: node.name }) : t('collapseFolder', { name: node.name })}
            onClick={(event) => {
              event.stopPropagation();
              onSelectTarget(contextTarget);
              onToggleFolder(node.path);
            }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : <span className="tree-chevron-spacer" aria-hidden="true" />}
        {isFolder
          ? collapsed
            ? <Folder className="tree-icon folder-icon" size={16} />
            : <FolderOpen className="tree-icon folder-icon open" size={16} />
          : <WorkspaceFileIcon kind={node.file.kind} />}
        {isRenaming ? (
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
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
        {active && <span className="tree-open-indicator" title={t('openDocument')} aria-label={t('openDocument')} />}
      </div>

      {isFolder && !collapsed && (
        <fieldset
          className="tree-branch-children"
          data-tree-parent-path={absolutePath}
          style={{ '--branch-guide-left': `${15 + depth * 16}px` } as CSSProperties}
        >
          <FileTreeRows
            activePath={activePath}
            collapsedFolders={collapsedFolders}
            depth={depth + 1}
            disabled={disabled}
            draggingPath={draggingPath}
            dropTargetPath={dropTargetPath}
            nodes={node.children}
            onBeginRename={onBeginRename}
            onCancelRename={onCancelRename}
            onCommitRename={onCommitRename}
            onDeleteEntry={onDeleteEntry}
            onOpenContextMenu={onOpenContextMenu}
            onOpenFile={onOpenFile}
            onSelectTarget={onSelectTarget}
            onToggleFolder={onToggleFolder}
            renamingPath={renamingPath}
            selectedPath={selectedPath}
          />
        </fieldset>
      )}
    </>
  );
}

export function FileTreeRows(props: FileTreeRowsProps) {
  return props.nodes.map((node) => (
    <FileTreeRow key={node.absolutePath} {...props} node={node} />
  ));
}
