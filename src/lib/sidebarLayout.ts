import type { CSSProperties } from 'react';
import type { WorkspaceFileKind } from '../types';
import { getWorkspacePresentation } from './workspaceFileKind';

export const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 264;
export const MIN_WORKSPACE_SIDEBAR_WIDTH = 180;
export const MAX_WORKSPACE_SIDEBAR_WIDTH = 420;
const WORKSPACE_SIDEBAR_KEYBOARD_STEP = 16;

export function clampWorkspaceSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
  return Math.min(MAX_WORKSPACE_SIDEBAR_WIDTH, Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, width));
}

export function resizeWorkspaceSidebarWidth(input: { startWidth: number; deltaX: number }): number {
  const deltaX = Number.isFinite(input.deltaX) ? input.deltaX : 0;
  return clampWorkspaceSidebarWidth(input.startWidth + deltaX);
}

export function resizeWorkspaceSidebarWidthFromKey(width: number, key: string): number | null {
  if (key === 'Home') return MIN_WORKSPACE_SIDEBAR_WIDTH;
  if (key === 'End') return MAX_WORKSPACE_SIDEBAR_WIDTH;
  if (key === 'ArrowLeft') return clampWorkspaceSidebarWidth(width - WORKSPACE_SIDEBAR_KEYBOARD_STEP);
  if (key === 'ArrowRight') return clampWorkspaceSidebarWidth(width + WORKSPACE_SIDEBAR_KEYBOARD_STEP);
  return null;
}

export function getWorkspaceSidebarLayoutStyle(width: number): CSSProperties & Record<'--workspace-sidebar-width', string> {
  return {
    '--workspace-sidebar-width': `${clampWorkspaceSidebarWidth(width)}px`,
  };
}

export function getWorkspaceLayoutClassName(fileTreeCollapsed: boolean, activeFileKind: WorkspaceFileKind = 'markdown'): string {
  const classes = ['workspace'];
  const presentation = getWorkspacePresentation(activeFileKind);
  if (fileTreeCollapsed) classes.push('sidebar-collapsed');
  if (presentation.preview === 'image') classes.push('image-mode');
  if (presentation.preview === 'media') classes.push('media-mode');
  if (presentation.preview === 'pdf' || presentation.preview === 'docx') {
    classes.push('document-mode');
  }
  if (presentation.preview === 'excalidraw') classes.push('excalidraw-mode');
  return classes.join(' ');
}

export function getSidebarToggleLabel(fileTreeCollapsed: boolean): string {
  return fileTreeCollapsed ? 'Expand file tree' : 'Collapse file tree';
}
