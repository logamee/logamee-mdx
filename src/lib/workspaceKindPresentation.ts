import type { WorkspaceFileKind } from '../types';
import { assertNever } from './workspaceDecodePrimitives';

export type WorkspacePresentation =
  | { editor: 'markdown'; preview: 'jinxiu-markdown' }
  | { editor: 'html'; preview: 'html' }
  | { preview: 'excalidraw' }
  | { preview: 'image' }
  | { media_kind: 'video' | 'audio'; preview: 'media' }
  | { preview: 'pdf' }
  | { preview: 'docx' };

export function decodeWorkspaceFileKind(value: unknown): WorkspaceFileKind {
  switch (value) {
    case 'markdown':
    case 'html':
    case 'excalidraw':
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'docx':
      return value;
    default:
      throw new Error('Invalid workspace file kind');
  }
}

export function getWorkspacePresentation(kind: WorkspaceFileKind): WorkspacePresentation {
  switch (kind) {
    case 'markdown':
      return { editor: 'markdown', preview: 'jinxiu-markdown' };
    case 'html':
      return { editor: 'html', preview: 'html' };
    case 'excalidraw':
      return { preview: 'excalidraw' };
    case 'image':
      return { preview: 'image' };
    case 'video':
      return { media_kind: 'video', preview: 'media' };
    case 'audio':
      return { media_kind: 'audio', preview: 'media' };
    case 'pdf':
      return { preview: 'pdf' };
    case 'docx':
      return { preview: 'docx' };
    default:
      return assertNever(kind);
  }
}
