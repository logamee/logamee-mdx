import { describe, expect, it } from 'vitest';
import { decodeWorkspaceSessionRestore } from './workspaceSession';

const workspace = {
  workspace_token: 'workspace-7',
  root: '/workspace',
  files: [{
    kind: 'markdown',
    path: '/workspace/notes.md',
    relative_path: 'notes.md',
    name: 'notes.md',
  }],
  directories: [],
};

const activeFile = {
  file: {
    kind: 'markdown',
    path: '/workspace/notes.md',
    content_mode: 'text',
    content: '# Notes',
    file_version: { canonicalPath: '/workspace/notes.md', platformIdentity: '1', length: '7', modifiedNanos: '1', sha256: 'c'.repeat(64) },
  },
  open_receipt: '0123456789abcdef0123456789abcdef',
  commit_operation_id: 'fedcba9876543210fedcba9876543210',
};

describe('workspace session restore wire decoding', () => {
  it('decodes an empty or prepared active workspace session', () => {
    expect(decodeWorkspaceSessionRestore(null)).toBeNull();
    expect(decodeWorkspaceSessionRestore({ workspace, active_file: null })).toEqual({
      workspace,
      active_file: null,
    });
    expect(decodeWorkspaceSessionRestore({ workspace, active_file: activeFile })).toEqual({
      workspace,
      active_file: activeFile,
    });
  });

  it('rejects missing, extra, and malformed restore fields', () => {
    expect(() => decodeWorkspaceSessionRestore({ workspace })).toThrow(
      'Invalid workspace session restore',
    );
    expect(() => decodeWorkspaceSessionRestore({ workspace, active_file: null, unexpected: true })).toThrow(
      'Invalid workspace session restore',
    );
    expect(() => decodeWorkspaceSessionRestore({
      workspace: { ...workspace, unexpected: true },
      active_file: null,
    })).toThrow('Invalid workspace session restore');
    expect(() => decodeWorkspaceSessionRestore({
      workspace,
      active_file: { ...activeFile, open_receipt: 'not-an-opaque-id' },
    })).toThrow('Invalid workspace session restore');
  });
});
