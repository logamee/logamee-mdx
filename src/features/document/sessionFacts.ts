import type { FileVersion, OpenFileResponse, WorkspaceFileEntry } from '../../types';

export function activePathInWorkspaceSnapshot(
  activePath: string | null,
  files: readonly WorkspaceFileEntry[],
): string | null {
  if (!activePath || !files.some((file) => file.path === activePath)) return null;
  return activePath;
}

export function editableFileVersion(file: OpenFileResponse): FileVersion | null {
  return file.kind === 'markdown' || file.kind === 'html' || file.kind === 'excalidraw'
    ? file.file_version
    : null;
}
