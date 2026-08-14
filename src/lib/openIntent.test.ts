import { describe, expect, it } from 'vitest';
import { decodeOpenIntentPreview, decodeResolvedOpenIntent } from './openIntent';

const prepared = {
  file: {
    kind: 'markdown',
    path: '/workspace/draft.md',
    content_mode: 'text',
    file_version: {
      canonicalPath: '/workspace/draft.md',
      platformIdentity: '1:2',
      length: '5',
      modifiedNanos: '7',
      sha256: 'a'.repeat(64),
    },
    content: 'draft',
  },
  open_receipt: 'a'.repeat(32),
  commit_operation_id: 'b'.repeat(32),
};

describe('open intent wire contracts', () => {
  it('decodes opaque previews and rejects path-shaped or unknown metadata', () => {
    expect(decodeOpenIntentPreview({
      id: 'open-intent-7',
      source: 'secondary_instance',
      displayPath: '/workspace/draft.md',
      targetKind: 'unknown',
    })).toEqual({
      id: 'open-intent-7',
      source: 'secondary_instance',
      displayPath: '/workspace/draft.md',
      targetKind: 'unknown',
    });
    expect(() => decodeOpenIntentPreview({
      id: '/workspace/draft.md',
      source: 'secondary_instance',
      displayPath: '/workspace/draft.md',
      targetKind: 'file',
    })).toThrow('Invalid open intent preview');
    expect(() => decodeOpenIntentPreview({
      id: 'open-intent-7',
      source: 'secondary_instance',
      displayPath: '/workspace/draft.md',
      targetKind: 'unknown',
      path: '/workspace/draft.md',
    })).toThrow('Invalid open intent preview');
  });

  it('accepts drag-drop as a backend-owned open source', () => {
    expect(decodeOpenIntentPreview({
      id: 'open-intent-9',
      source: 'drag_drop',
      displayPath: '/workspace/dropped.md',
      targetKind: 'unknown',
    })).toEqual({
      id: 'open-intent-9',
      source: 'drag_drop',
      displayPath: '/workspace/dropped.md',
      targetKind: 'unknown',
    });
  });

  it('decodes file and directory resolutions through existing strict contracts', () => {
    expect(decodeResolvedOpenIntent({ kind: 'file', prepared })).toEqual({
      kind: 'file',
      prepared: {
        ...prepared,
        file: {
          ...prepared.file,
          file_version: prepared.file.file_version,
        },
      },
    });
    expect(decodeResolvedOpenIntent({
      kind: 'directory',
      workspace: {
        workspace_token: 'workspace-7',
        root: '/workspace',
        files: [],
        directories: [],
      },
      workspace_open_receipt: 'workspace-open-7',
    })).toEqual({
      kind: 'directory',
      workspace: {
        workspace_token: 'workspace-7',
        root: '/workspace',
        files: [],
        directories: [],
      },
      workspace_open_receipt: 'workspace-open-7',
    });
    expect(() => decodeResolvedOpenIntent({
      kind: 'directory',
      workspace: {
        workspace_token: 'workspace-7',
        root: '/workspace',
        files: [],
        directories: [],
      },
    })).toThrow('Invalid resolved open intent');
    expect(() => decodeResolvedOpenIntent({ kind: 'file', prepared: null })).toThrow(
      'Invalid resolved open intent',
    );
    for (const workspaceOpenReceipt of ['workspace-open-00', 'workspace-open-01', 'workspace-open-x']) {
      expect(() => decodeResolvedOpenIntent({
        kind: 'directory',
        workspace: {
          workspace_token: 'workspace-7',
          root: '/workspace',
          files: [],
          directories: [],
        },
        workspace_open_receipt: workspaceOpenReceipt,
      })).toThrow('Invalid resolved open intent');
    }
  });

  it('accepts the zero-valued receipt allocated for the first workspace open', () => {
    expect(decodeResolvedOpenIntent({
      kind: 'directory',
      workspace: {
        workspace_token: 'workspace-0',
        root: '/workspace',
        files: [],
        directories: [],
      },
      workspace_open_receipt: 'workspace-open-0',
    })).toEqual({
      kind: 'directory',
      workspace: {
        workspace_token: 'workspace-0',
        root: '/workspace',
        files: [],
        directories: [],
      },
      workspace_open_receipt: 'workspace-open-0',
    });
  });

  it('decodes an opaque session restore without accepting path fields in its preview', () => {
    expect(decodeOpenIntentPreview({
      id: 'open-intent-8',
      source: 'session_restore',
      displayPath: 'Restore previous workspace',
      targetKind: 'session_restore',
    })).toEqual({
      id: 'open-intent-8',
      source: 'session_restore',
      displayPath: 'Restore previous workspace',
      targetKind: 'session_restore',
    });
    expect(decodeResolvedOpenIntent({
      kind: 'session_restore',
      restore: null,
      workspace_open_receipt: null,
    })).toEqual({
      kind: 'session_restore',
      restore: null,
      workspace_open_receipt: null,
    });
    expect(decodeResolvedOpenIntent({
      kind: 'session_restore',
      restore: {
        workspace: {
          workspace_token: 'workspace-7',
          root: '/workspace',
          files: [],
          directories: [],
        },
        active_file: prepared,
      },
      workspace_open_receipt: 'workspace-open-8',
    })).toEqual({
      kind: 'session_restore',
      restore: {
        workspace: {
          workspace_token: 'workspace-7',
          root: '/workspace',
          files: [],
          directories: [],
        },
        active_file: prepared,
      },
      workspace_open_receipt: 'workspace-open-8',
    });
    expect(() => decodeResolvedOpenIntent({
      kind: 'session_restore',
      restore: { workspace: { workspace_token: 'workspace-7', root: '/workspace' } },
      workspace_open_receipt: 'workspace-open-8',
    })).toThrow('Invalid resolved open intent');
    expect(() => decodeResolvedOpenIntent({
      kind: 'session_restore',
      restore: null,
      workspace_open_receipt: null,
      path: '/workspace',
    })).toThrow('Invalid resolved open intent');
    expect(() => decodeResolvedOpenIntent({
      kind: 'session_restore',
      restore: null,
      workspace_open_receipt: 'workspace-open-8',
    })).toThrow('Invalid resolved open intent');
  });
});
