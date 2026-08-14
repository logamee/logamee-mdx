import { describe, expect, it } from 'vitest';
import {
  clampWorkspaceSidebarWidth,
  DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
  getSidebarToggleLabel,
  getWorkspaceLayoutClassName,
  getWorkspaceSidebarLayoutStyle,
  MAX_WORKSPACE_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDEBAR_WIDTH,
  resizeWorkspaceSidebarWidth,
  resizeWorkspaceSidebarWidthFromKey,
} from './sidebarLayout';

describe('sidebar layout', () => {
  it('uses a compact workspace layout when the file tree sidebar is collapsed', () => {
    expect(getWorkspaceLayoutClassName(false)).toBe('workspace');
    expect(getWorkspaceLayoutClassName(true)).toBe('workspace sidebar-collapsed');
  });

  it('uses a single preview pane layout for image files', () => {
    expect(getWorkspaceLayoutClassName(false, 'image')).toBe('workspace image-mode');
    expect(getWorkspaceLayoutClassName(true, 'image')).toBe('workspace sidebar-collapsed image-mode');
  });

  it('uses a single preview pane layout for audio and video files', () => {
    expect(getWorkspaceLayoutClassName(false, 'video')).toBe('workspace media-mode');
    expect(getWorkspaceLayoutClassName(true, 'audio')).toBe('workspace sidebar-collapsed media-mode');
    expect(getWorkspaceLayoutClassName(false, 'html')).toBe('workspace');
  });

  it('uses a single canvas layout for Excalidraw files', () => {
    expect(getWorkspaceLayoutClassName(false, 'excalidraw')).toBe('workspace excalidraw-mode');
    expect(getWorkspaceLayoutClassName(true, 'excalidraw')).toBe('workspace sidebar-collapsed excalidraw-mode');
  });

  it('uses accessible toggle labels for collapsing and expanding the file tree', () => {
    expect(getSidebarToggleLabel(false)).toBe('Collapse file tree');
    expect(getSidebarToggleLabel(true)).toBe('Expand file tree');
  });

  it('clamps pointer resizing to a stable desktop width range', () => {
    expect(DEFAULT_WORKSPACE_SIDEBAR_WIDTH).toBe(264);
    expect(MIN_WORKSPACE_SIDEBAR_WIDTH).toBe(180);
    expect(MAX_WORKSPACE_SIDEBAR_WIDTH).toBe(420);
    expect(resizeWorkspaceSidebarWidth({ startWidth: 264, deltaX: 48 })).toBe(312);
    expect(resizeWorkspaceSidebarWidth({ startWidth: 264, deltaX: -200 })).toBe(180);
    expect(resizeWorkspaceSidebarWidth({ startWidth: 264, deltaX: 400 })).toBe(420);
    expect(clampWorkspaceSidebarWidth(Number.NaN)).toBe(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
  });

  it('supports keyboard resizing and exact boundary jumps', () => {
    expect(resizeWorkspaceSidebarWidthFromKey(264, 'ArrowLeft')).toBe(248);
    expect(resizeWorkspaceSidebarWidthFromKey(264, 'ArrowRight')).toBe(280);
    expect(resizeWorkspaceSidebarWidthFromKey(264, 'Home')).toBe(180);
    expect(resizeWorkspaceSidebarWidthFromKey(264, 'End')).toBe(420);
    expect(resizeWorkspaceSidebarWidthFromKey(264, 'Enter')).toBeNull();
  });

  it('exposes the current session width as a workspace CSS variable', () => {
    expect(getWorkspaceSidebarLayoutStyle(312)).toEqual({
      '--workspace-sidebar-width': '312px',
    });
    expect(getWorkspaceSidebarLayoutStyle(999)).toEqual({
      '--workspace-sidebar-width': '420px',
    });
  });
});
