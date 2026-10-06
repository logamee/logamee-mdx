import type { FileTreeContextTarget } from '../../lib/fileTreeContextMenu';

export type WorkspaceTreeTarget = Exclude<FileTreeContextTarget, { kind: 'root' }>;



export interface PointerDragSession {
  active: boolean;
  pointerId: number;
  source: WorkspaceTreeTarget;
  sourceElement: HTMLElement;
  startX: number;
  startY: number;
}

export const POINTER_DRAG_THRESHOLD = 6;
