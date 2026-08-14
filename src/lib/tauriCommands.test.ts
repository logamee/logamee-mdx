import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeResourceDirectory,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  cancelDocumentOverwriteToken,
  getSettings,
  getPackagedOpenE2eConfig,
  issueDocumentOverwriteToken,
  moveWorkspaceEntry,
  openDirectoryDialog,
  openFileDialog,
  peekOpenIntent,
  persistWorkspaceSession,
  prepareHtmlPreview,
  prepareMarkdownHtmlEmbed,
  releaseMarkdownHtmlEmbed,
  readMarkdownExcalidraw,
  readWorkspaceImage,
  resetSettings,
  refreshDirectory,
  renameWorkspaceEntry,
  retryDocumentSaveWithToken,
  resolveWorkspaceMedia,
  resolveOpenIntent,
  discardOpenIntent,
  focusMainWindow,
  settleOpenIntentWorkspace,
  cancelWorkspaceIndexOperation,
  discardWorkspaceIndex,
  openWorkspaceIndexResult,
  queryWorkspaceIndex,
  rebuildWorkspaceIndex,
  recordPackagedOpenAppEvent,
  requestSessionRestore,
  saveAsDialog,
  saveExport,
  saveExcalidrawBundle,
  setNativeSaveMenuEnabled,
  setNativeLocalePreference,
  setNativeThemePreference,
  updateSettings,
  writeFile,
  writeExcalidrawAssetPair,
  writeWorkspaceResource,
} from './tauriCommands';

const invokeMock = vi.hoisted(() => vi.fn<(command: string, payload?: unknown) => Promise<unknown>>());

const workspaceSnapshot = {
  workspace_token: 'workspace-7',
  root: '/workspace',
  files: [],
  directories: [],
};

const fileVersion = {
  canonicalPath: '/workspace/draft.md',
  platformIdentity: '1:2',
  length: '7',
  modifiedNanos: '12',
  sha256: 'a'.repeat(64),
};

const committedCreateOutcome = {
  status: 'confirmed-committed',
  receipt: {
    committed: {
      kind: 'markdown',
      path: '/workspace/draft.md',
      content_mode: 'text',
      content: '',
      file_version: fileVersion,
    },
    workspace: {
      status: 'stale',
      workspace_token: 'workspace-7',
      repair_reason: 'injected post-commit snapshot failure',
    },
  },
};

const committedDirectoryOutcome = {
  status: 'confirmed-committed',
  receipt: {
    committed: {
      path: '/workspace/drafts',
    },
    workspace: {
      status: 'stale',
      workspace_token: 'workspace-7',
      repair_reason: 'injected post-commit snapshot failure',
    },
  },
};

const committedRenameOutcome = {
  status: 'confirmed-committed',
  receipt: {
    committed: {
      entry_kind: 'file',
      old_path: '/workspace/draft.md',
      new_path: '/workspace/renamed.md',
    },
    workspace: {
      status: 'stale',
      workspace_token: 'workspace-7',
      repair_reason: 'injected post-commit snapshot failure',
    },
  },
};

const committedDeleteOutcome = {
  status: 'confirmed-committed',
  receipt: {
    committed: {
      deleted_path: '/workspace/drafts',
    },
    workspace: {
      status: 'stale',
      workspace_token: 'workspace-7',
      repair_reason: 'injected post-commit snapshot failure',
    },
  },
};

const committedMoveOutcome = {
  status: 'confirmed-committed',
  receipt: {
    committed: {
      entry_kind: 'file',
      old_path: '/workspace/draft.md',
      new_path: '/workspace/archive/draft.md',
    },
    workspace: {
      status: 'stale',
      workspace_token: 'workspace-7',
      repair_reason: 'injected post-commit snapshot failure',
    },
  },
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('Tauri command wrappers', () => {
  const expectedVersion = fileVersion;
  const overwriteToken = 'c'.repeat(64);

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses the exact settings command names and projects their current envelopes', async () => {
    const envelope = {
      schemaVersion: 1,
      revision: 7,
      settings: {
        autosaveEnabled: true,
        autosaveDelayMs: 1000,
        spellcheckEnabled: true,
        wikilinksEnabled: false,
        resourceDirectory: 'assets',
        editorPaneRatio: 0.5,
        selectedSkin: 'jinxiu-zhusha',
        followSystemTheme: false,
        localeMode: 'system',
        shortcuts: {},
        exportProfiles: {},
      },
    } as const;
    invokeMock.mockResolvedValue(envelope);

    await expect(getSettings()).resolves.toEqual(envelope);
    await expect(updateSettings(envelope.settings, 6)).resolves.toEqual(envelope);
    await expect(resetSettings(7)).resolves.toEqual(envelope);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_settings');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'update_settings', { expectedRevision: 6, settings: envelope.settings });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'reset_settings', { expectedRevision: 7 });
  });

  it('routes opaque open-intent commands without accepting a frontend path', async () => {
    invokeMock
      .mockResolvedValueOnce({
        id: 'open-intent-7',
        source: 'secondary_instance',
        displayPath: '/workspace/draft.md',
        targetKind: 'unknown',
      })
      .mockResolvedValueOnce({ kind: 'file', prepared: {
        file: {
          kind: 'markdown',
          path: '/workspace/draft.md',
          content_mode: 'text',
          file_version: fileVersion,
          content: 'draft',
        },
        open_receipt: 'a'.repeat(32),
        commit_operation_id: 'b'.repeat(32),
      } })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce('applied');

    await expect(peekOpenIntent()).resolves.toMatchObject({ id: 'open-intent-7' });
    await expect(resolveOpenIntent('open-intent-7')).resolves.toMatchObject({ kind: 'file' });
    await expect(discardOpenIntent('open-intent-7')).resolves.toBe(true);
    await expect(settleOpenIntentWorkspace('workspace-open-7', true)).resolves.toBe('applied');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'peek_open_intent');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'resolve_open_intent', { intentId: 'open-intent-7' });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'discard_open_intent', { intentId: 'open-intent-7' });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'settle_open_intent_workspace', {
      workspaceOpenReceipt: 'workspace-open-7',
      applied: true,
    });
  });

  it('focuses the existing main window with opaque intent evidence metadata', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(focusMainWindow('open-intent-7', true)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('focus_main_window', {
      intentId: 'open-intent-7',
      coalesced: true,
    });
  });

  it('asks the backend to append one opaque session-restore intent', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(requestSessionRestore()).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('request_session_restore');
  });

  it('validates packaged-open config and forwards typed app evidence events', async () => {
    const config = {
      profile: 'apply-reobserve',
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md',
        unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md',
        associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace',
        staleFile: '/fixtures/stale.md',
      },
    } as const;
    const event = {
      type: 'app_activated',
      intentId: 'open-intent-1',
      step: 'cli-primary',
      fields: { dirty: false },
    } as const;
    invokeMock.mockResolvedValueOnce(config).mockResolvedValueOnce(undefined);

    await expect(getPackagedOpenE2eConfig()).resolves.toEqual(config);
    await expect(recordPackagedOpenAppEvent(event)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_packaged_open_e2e_config');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'record_packaged_open_app_event', { event });
  });

  it('rejects malformed packaged-open config instead of guessing fixture paths', async () => {
    invokeMock.mockResolvedValueOnce({
      profile: 'apply-reobserve',
      paths: { primaryFile: '/fixtures/primary.md' },
    });

    await expect(getPackagedOpenE2eConfig()).rejects.toThrow('Invalid packaged open E2E config');
  });

  it('uses workspace-token scoped index commands and never sends an absolute result path', async () => {
    const report = {
      implementationId: 'mmd-memory-substring-v1',
      schemaId: 'mmd-workspace-index-v1',
      corpusDigest: 'a'.repeat(64),
      limits: {
        maxFiles: 100000,
        maxFileBytes: 1048576,
        maxAggregateBytes: 268435456,
        maxResults: 100,
        maxQueryChars: 256,
        maxSnippetChars: 240,
      },
      inputFiles: 1,
      indexedFiles: 1,
      indexedBytes: 7,
      estimatedIndexBytes: 15,
      skipped: {
        unsupported: 0,
        invalidRelativePath: 0,
        duplicatePath: 0,
        oversized: 0,
        aggregateLimit: 0,
        fileCountLimit: 0,
      },
    };
    invokeMock
      .mockResolvedValueOnce({
        status: 'ready',
        workspaceToken: 'workspace-7',
        indexGeneration: 3,
        implementationId: report.implementationId,
        schemaId: report.schemaId,
        report,
        scanReport: {
          scannedFiles: 1,
          collectedFiles: 1,
          collectedBytes: 7,
          readErrors: 0,
          skipped: report.skipped,
        },
      })
      .mockResolvedValueOnce({
        status: 'ready',
        workspaceToken: 'workspace-7',
        indexGeneration: 3,
        implementationId: report.implementationId,
        schemaId: report.schemaId,
        truncated: false,
        results: [{ relativePath: 'notes/draft.md', snippet: 'Draft', location: null }],
      })
      .mockResolvedValueOnce({ discarded: true, indexGeneration: 4 })
      .mockResolvedValueOnce({ cancelled: true })
      .mockResolvedValueOnce({
        file: {
          kind: 'markdown',
          path: '/workspace/notes/draft.md',
          content_mode: 'text',
          file_version: fileVersion,
          content: 'Draft',
        },
        open_receipt: 'a'.repeat(32),
        commit_operation_id: 'b'.repeat(32),
      });

    await expect(rebuildWorkspaceIndex('workspace-7', '/workspace', 'build-1')).resolves.toMatchObject({
      indexGeneration: 3,
    });
    await expect(queryWorkspaceIndex('workspace-7', '/workspace', 'query-1', {
      kind: 'fullText', text: 'draft',
    })).resolves.toMatchObject({ results: [{ relativePath: 'notes/draft.md' }] });
    await expect(discardWorkspaceIndex('workspace-7', '/workspace')).resolves.toEqual({
      discarded: true,
      indexGeneration: 4,
    });
    await expect(cancelWorkspaceIndexOperation('query-1')).resolves.toBe(true);
    await expect(openWorkspaceIndexResult(
      'workspace-7', '/workspace', 3, 'notes/draft.md',
    )).resolves.toMatchObject({ file: { path: '/workspace/notes/draft.md' } });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'rebuild_workspace_index', {
      workspaceToken: 'workspace-7', workspaceRoot: '/workspace', operationId: 'build-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'query_workspace_index', {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      operationId: 'query-1',
      query: { kind: 'fullText', text: 'draft' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'open_workspace_index_result', {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      indexGeneration: 3,
      relativePath: 'notes/draft.md',
    });
  });

  it('syncs the validated frontend theme preference into the native menu projection', async () => {
    invokeMock.mockResolvedValue(undefined);

    await setNativeThemePreference({
      version: 1,
      selectedSkin: 'songke-zhuying',
      followSystem: true,
    });

    expect(invokeMock).toHaveBeenCalledWith('set_native_theme_preference', {
      selectedSkin: 'songke-zhuying',
      followSystem: true,
    });
  });

  it('syncs locale mode and effective language into the native menu projection', async () => {
    invokeMock.mockResolvedValue(undefined);

    await setNativeLocalePreference({ version: 1, mode: 'system' }, 'zh-CN');

    expect(invokeMock).toHaveBeenCalledWith('set_native_locale_preference', {
      mode: 'system',
      effectiveLocale: 'zh-CN',
    });
  });

  it('rejects a legacy null write response before treating the save as complete', async () => {
    invokeMock.mockResolvedValue(null);

    await expect(writeFile('/workspace/draft.md', '# Saved', expectedVersion, 'save-1')).rejects.toThrow(
      'Invalid document save response',
    );
    expect(invokeMock).toHaveBeenCalledWith('write_file', {
      path: '/workspace/draft.md',
      content: '# Saved',
      expectedVersion,
      operationId: 'save-1',
    });
  });

  it('returns conflicts and indeterminate saves as data and wires overwrite commands exactly', async () => {
    const conflict = {
      status: 'conflict',
      path: '/workspace/draft.md',
      current_version: expectedVersion,
      message: 'The file changed on disk.',
    } as const;
    const indeterminate = {
      status: 'indeterminate',
      path: '/workspace/draft.md',
      message: 'Inspect the file before retrying.',
    } as const;
    invokeMock
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce({ overwriteToken })
      .mockResolvedValueOnce(indeterminate)
      .mockResolvedValueOnce(undefined);

    await expect(writeFile('/workspace/draft.md', '# Saved', expectedVersion, 'save-1')).resolves.toEqual(conflict);
    await expect(issueDocumentOverwriteToken('/workspace/draft.md', '# Saved', 'save-1')).resolves.toEqual({
      overwriteToken,
    });
    await expect(
      retryDocumentSaveWithToken('/workspace/draft.md', '# Saved', 'save-1', overwriteToken),
    ).resolves.toEqual(indeterminate);
    await expect(cancelDocumentOverwriteToken('/workspace/draft.md', overwriteToken)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'write_file', {
      path: '/workspace/draft.md',
      content: '# Saved',
      expectedVersion,
      operationId: 'save-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'issue_document_overwrite_token', {
      path: '/workspace/draft.md',
      content: '# Saved',
      operationId: 'save-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'retry_document_save_with_token', {
      path: '/workspace/draft.md',
      content: '# Saved',
      operationId: 'save-1',
      overwriteToken,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'cancel_document_overwrite_token', {
      path: '/workspace/draft.md',
      overwriteToken,
    });
  });

  it('calls exact workspace mutation command names with stable payloads', async () => {
    invokeMock
      .mockResolvedValueOnce(committedCreateOutcome)
      .mockResolvedValueOnce(workspaceSnapshot)
      .mockResolvedValueOnce(committedDirectoryOutcome)
      .mockResolvedValueOnce(committedRenameOutcome)
      .mockResolvedValueOnce(committedMoveOutcome)
      .mockResolvedValue(committedDeleteOutcome);

    await expect(createWorkspaceFile('workspace-7', '/workspace', 'draft.md')).resolves.toEqual(
      committedCreateOutcome,
    );
    await expect(refreshDirectory('workspace-7', '/workspace')).resolves.toEqual(workspaceSnapshot);
    await expect(createWorkspaceDirectory('workspace-7', '/workspace', 'drafts')).resolves.toEqual(
      committedDirectoryOutcome,
    );
    await expect(renameWorkspaceEntry('workspace-7', '/workspace/draft.md', 'renamed.md')).resolves.toEqual(
      committedRenameOutcome,
    );
    await expect(moveWorkspaceEntry('workspace-7', '/workspace/draft.md', '/workspace/archive')).resolves.toEqual(
      committedMoveOutcome,
    );
    await expect(deleteWorkspaceEntry('workspace-7', '/workspace/drafts')).resolves.toEqual(
      committedDeleteOutcome,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_workspace_file', {
      workspaceToken: 'workspace-7',
      parentPath: '/workspace',
      name: 'draft.md',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'refresh_directory', {
      workspaceToken: 'workspace-7',
      path: '/workspace',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'create_workspace_directory', {
      workspaceToken: 'workspace-7',
      parentPath: '/workspace',
      name: 'drafts',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'rename_workspace_entry', {
      workspaceToken: 'workspace-7',
      path: '/workspace/draft.md',
      newName: 'renamed.md',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'move_workspace_entry', {
      workspaceToken: 'workspace-7',
      path: '/workspace/draft.md',
      destinationParentPath: '/workspace/archive',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'delete_workspace_entry', {
      workspaceToken: 'workspace-7',
      path: '/workspace/drafts',
    });

    invokeMock.mockResolvedValueOnce({ status: 'confirmed-committed' });
    await expect(createWorkspaceFile('workspace-7', '/workspace', 'invalid.md')).rejects.toThrow(
      'Invalid mutation outcome',
    );

    invokeMock.mockResolvedValueOnce({
      status: 'confirmed-committed',
      receipt: {
        committed: { path: 7 },
        workspace: { status: 'not-applicable' },
      },
    });
    await expect(createWorkspaceDirectory('workspace-7', '/workspace', 'invalid')).rejects.toThrow(
      'Invalid mutation outcome',
    );

    invokeMock.mockResolvedValueOnce({
      ...committedRenameOutcome,
      receipt: {
        ...committedRenameOutcome.receipt,
        committed: {
          ...committedRenameOutcome.receipt.committed,
          directory: workspaceSnapshot,
        },
      },
    });
    await expect(renameWorkspaceEntry('workspace-7', '/workspace/draft.md', 'renamed.md')).rejects.toThrow(
      'Invalid mutation outcome',
    );

    invokeMock.mockResolvedValueOnce({
      ...committedDeleteOutcome,
      receipt: {
        ...committedDeleteOutcome.receipt,
        committed: { deletedPath: '/workspace/drafts' },
      },
    });
    await expect(deleteWorkspaceEntry('workspace-7', '/workspace/drafts')).rejects.toThrow(
      'Invalid mutation outcome',
    );
  });

  it('decodes an indeterminate create-file outcome without claiming a commit', async () => {
    const outcome = {
      status: 'indeterminate',
      operation: 'create',
      paths: ['/workspace/draft.md'],
      recovery_message: 'Refresh and inspect the workspace before retrying.',
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(createWorkspaceFile('workspace-7', '/workspace', 'draft.md')).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith('create_workspace_file', {
      workspaceToken: 'workspace-7',
      parentPath: '/workspace',
      name: 'draft.md',
    });
  });

  it('passes the explicit Excalidraw kind when creating a standard drawing', async () => {
    const outcome = {
      status: 'confirmed-committed',
      receipt: {
        committed: {
          kind: 'excalidraw',
          path: '/workspace/architecture.excalidraw',
          content_mode: 'text',
          content: '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
          file_version: fileVersion,
        },
        workspace: { status: 'not-applicable' },
      },
    } as const;
    invokeMock.mockResolvedValue(outcome);

    await expect(createWorkspaceFile(
      'workspace-7',
      '/workspace',
      'architecture',
      'excalidraw',
    )).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith('create_workspace_file', {
      fileKind: 'excalidraw',
      workspaceToken: 'workspace-7',
      parentPath: '/workspace',
      name: 'architecture',
    });
  });

  it('calls stable dialog command names with their existing request fields', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(workspaceSnapshot)
      .mockResolvedValueOnce(null);

    await openFileDialog();
    await expect(openDirectoryDialog()).resolves.toEqual(workspaceSnapshot);
    await saveAsDialog('# Draft', 'Draft.md', 'save-as-1');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'open_file_dialog');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'open_directory_dialog');
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'save_as_dialog', {
      content: '# Draft',
      defaultName: 'Draft.md',
      operationId: 'save-as-1',
    });
  });

  it('persists workspace session state through the stable command', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(persistWorkspaceSession(
      'workspace-7',
      '/workspace',
      '/workspace/notes.md',
    )).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('persist_workspace_session', {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      activePath: '/workspace/notes.md',
    });
  });

  it('updates native Save and Save As availability through one focused command', async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(setNativeSaveMenuEnabled(false)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('set_native_save_menu_enabled', {
      enabled: false,
    });
  });

  it('decodes a committed versioned Save As response', async () => {
    const outcome = {
      status: 'confirmed_committed',
      path: '/workspace/saved.md',
      version: fileVersion,
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(saveAsDialog('# Draft', 'Draft.md', 'save-as-2')).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith('save_as_dialog', {
      content: '# Draft',
      defaultName: 'Draft.md',
      operationId: 'save-as-2',
    });
  });

  it('restricts an Excalidraw Save As request to the Excalidraw backend flow', async () => {
    const outcome = {
      status: 'confirmed_committed',
      path: '/workspace/architecture.excalidraw',
      version: fileVersion,
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(saveAsDialog(
      '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
      'architecture.excalidraw',
      'save-as-3',
      'excalidraw',
    )).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith('save_as_dialog', {
      content: '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
      defaultName: 'architecture.excalidraw',
      operationId: 'save-as-3',
      fileKind: 'excalidraw',
    });
  });

  it('preserves save-as cancellation as null', async () => {
    invokeMock.mockResolvedValue(null);

    await expect(saveAsDialog('# Draft', 'Draft.md', 'save-as-4')).resolves.toBeNull();
  });

  it('reads an authorized workspace image as a browser-safe data URL', async () => {
    invokeMock.mockResolvedValue('data:image/png;base64,iVBORw==');

    await expect(readWorkspaceImage('/workspace/assets/cover.png')).resolves.toBe('data:image/png;base64,iVBORw==');
    expect(invokeMock).toHaveBeenCalledWith('read_workspace_image', {
      path: '/workspace/assets/cover.png',
    });
  });

  it('writes a workspace resource through a strictly decoded Tauri command', async () => {
    invokeMock.mockResolvedValue({
      relativePath: 'assets/0123456789abcdef0123456789abcdef.png',
      markdownPath: 'assets/0123456789abcdef0123456789abcdef.png',
      fileName: '0123456789abcdef0123456789abcdef.png',
      digestMd5: '0123456789abcdef0123456789abcdef',
      created: true,
    });

    await expect(writeWorkspaceResource({
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      documentPath: '/workspace/draft.md',
      resourceDirectory: 'assets',
      bytesBase64: 'iVBORw==',
      mimeType: 'image/png',
      suggestedName: 'cover.png',
      trustedGenerated: true,
      resourceDirectoryToken: 'workspace-9',
    })).resolves.toEqual({
      relativePath: 'assets/0123456789abcdef0123456789abcdef.png',
      markdownPath: 'assets/0123456789abcdef0123456789abcdef.png',
      fileName: '0123456789abcdef0123456789abcdef.png',
      digestMd5: '0123456789abcdef0123456789abcdef',
      created: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('write_workspace_resource', {
      input: {
        workspaceToken: 'workspace-7',
        workspaceRoot: '/workspace',
        documentPath: '/workspace/draft.md',
        resourceDirectory: 'assets',
        bytesBase64: 'iVBORw==',
        mimeType: 'image/png',
        suggestedName: 'cover.png',
        trustedGenerated: true,
        resourceDirectoryToken: 'workspace-9',
      },
    });
  });

  it('authorizes an absolute resource directory through the native folder picker', async () => {
    invokeMock.mockResolvedValue({
      path: '/shared/mmd-assets',
      token: 'workspace-9',
    });

    await expect(authorizeResourceDirectory()).resolves.toEqual({
      path: '/shared/mmd-assets',
      token: 'workspace-9',
    });
    expect(invokeMock).toHaveBeenCalledWith('authorize_resource_directory_dialog');

    invokeMock.mockResolvedValueOnce(null);
    await expect(authorizeResourceDirectory()).resolves.toBeNull();
  });

  it('writes a generated Excalidraw SVG/PNG pair through a strict decoder', async () => {
    invokeMock.mockResolvedValue({
      svgMarkdownPath: '../assets/excalidraw-assets/system-abc.svg',
      pngMarkdownPath: '../assets/excalidraw-assets/system-abc.png',
      svgFileName: 'system-abc.svg',
      pngFileName: 'system-abc.png',
      sourceSha256: 'a'.repeat(64),
      updated: true,
    });

    await expect(writeExcalidrawAssetPair({
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      documentPath: '/workspace/docs/guide.md',
      sourceRelativePath: 'diagrams/system.excalidraw',
      sourceContent: '{"type":"excalidraw","version":2}',
      resourceDirectory: 'assets',
      svgBase64: 'PHN2Zy8+',
      pngBase64: 'iVBORw==',
    })).resolves.toEqual({
      svgMarkdownPath: '../assets/excalidraw-assets/system-abc.svg',
      pngMarkdownPath: '../assets/excalidraw-assets/system-abc.png',
      svgFileName: 'system-abc.svg',
      pngFileName: 'system-abc.png',
      sourceSha256: 'a'.repeat(64),
      updated: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('write_excalidraw_asset_pair', {
      input: {
        workspaceToken: 'workspace-7',
        workspaceRoot: '/workspace',
        documentPath: '/workspace/docs/guide.md',
        sourceRelativePath: 'diagrams/system.excalidraw',
        sourceContent: '{"type":"excalidraw","version":2}',
        resourceDirectory: 'assets',
        svgBase64: 'PHN2Zy8+',
        pngBase64: 'iVBORw==',
      },
    });
  });

  it('rejects malformed Excalidraw asset pair responses', async () => {
    invokeMock.mockResolvedValue({
      svgMarkdownPath: '../assets/system.svg',
      pngMarkdownPath: '../assets/system.png',
      svgFileName: 'system.svg',
      pngFileName: 'system.png',
      sourceSha256: 'not-a-sha256',
      updated: false,
    });

    await expect(writeExcalidrawAssetPair({
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      documentPath: '/workspace/docs/guide.md',
      sourceRelativePath: 'diagrams/system.excalidraw',
      sourceContent: '{}',
      resourceDirectory: 'assets',
      svgBase64: 'PHN2Zy8+',
      pngBase64: 'iVBORw==',
    })).rejects.toThrow('Invalid Excalidraw asset pair response');
  });

  it('rejects malformed workspace resource responses', async () => {
    invokeMock.mockResolvedValue({
      relativePath: 'assets/image.png',
      markdownPath: 'assets/image.png',
      fileName: 'image.png',
      digestMd5: 'not-md5',
      created: true,
    });

    await expect(writeWorkspaceResource({
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
      documentPath: '/workspace/draft.md',
      resourceDirectory: 'assets',
      bytesBase64: 'iVBORw==',
      mimeType: 'image/png',
    })).rejects.toThrow('Invalid workspace resource response');
  });

  it('resolves authorized media before creating an asset URL', async () => {
    invokeMock.mockResolvedValue('/workspace/media/clip.mp4');

    await expect(resolveWorkspaceMedia('/workspace/media/clip.mp4')).resolves.toBe('/workspace/media/clip.mp4');
    expect(invokeMock).toHaveBeenCalledWith('resolve_workspace_media', {
      path: '/workspace/media/clip.mp4',
    });
  });

  it('prepares live HTML content on the loopback preview server', async () => {
    invokeMock.mockResolvedValue('http://127.0.0.1:43127/site/index.html');

    await expect(prepareHtmlPreview('/workspace/site/index.html', '<h1>Draft</h1>')).resolves.toBe('http://127.0.0.1:43127/site/index.html');
    expect(invokeMock).toHaveBeenCalledWith('prepare_html_preview', {
      path: '/workspace/site/index.html',
      content: '<h1>Draft</h1>',
    });
  });

  it('prepares a Markdown HTML embed from its document-relative source', async () => {
    invokeMock.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demos/counter.html',
      ownerId: 41,
    });

    await expect(prepareMarkdownHtmlEmbed(
      '/workspace/docs/guide.md',
      '../demos/counter.html',
      '/workspace',
    )).resolves.toEqual({
      url: 'http://127.0.0.1:43127/demos/counter.html',
      ownerId: 41,
    });
    expect(invokeMock).toHaveBeenCalledWith('prepare_markdown_html_embed', {
      htmlSrc: '../demos/counter.html',
      markdownPath: '/workspace/docs/guide.md',
      workspaceRoot: '/workspace',
    });
  });

  it('reads a Markdown Excalidraw embed from its document-relative source', async () => {
    invokeMock.mockResolvedValue('{"type":"excalidraw","version":2}');

    await expect(readMarkdownExcalidraw(
      '/workspace/docs/guide.md',
      '../diagrams/system.excalidraw',
      '/workspace',
    )).resolves.toBe('{"type":"excalidraw","version":2}');
    expect(invokeMock).toHaveBeenCalledWith('read_markdown_excalidraw', {
      currentFilePath: '/workspace/docs/guide.md',
      excalidrawSrc: '../diagrams/system.excalidraw',
      workspaceRoot: '/workspace',
    });
  });

  it('releases a Markdown HTML embed owner through its focused command', async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(releaseMarkdownHtmlEmbed(41)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('release_markdown_html_embed', {
      ownerId: 41,
    });
  });

  it('saves validated export bytes and preserves dialog cancellation', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/exports/guide.html', bytesWritten: 42 });
    await expect(saveExport({ kind: 'html', defaultName: 'guide.html', bytesBase64: 'PGgxLz4=' }))
      .resolves.toEqual({ path: '/exports/guide.html', bytesWritten: 42 });
    expect(invokeMock).toHaveBeenCalledWith('save_export_dialog', {
      input: { kind: 'html', defaultName: 'guide.html', bytesBase64: 'PGgxLz4=' },
    });

    invokeMock.mockResolvedValueOnce(null);
    await expect(saveExport({ kind: 'png', defaultName: 'guide.png', bytesBase64: 'iVBORw==' }))
      .resolves.toBeNull();
  });

  it('rejects malformed export responses', async () => {
    invokeMock.mockResolvedValue({ path: '', bytesWritten: -1 });
    await expect(saveExport({ kind: 'html', defaultName: 'guide.html', bytesBase64: 'PGgxLz4=' }))
      .rejects.toThrow('Invalid export response');
  });

  it('saves exactly five Excalidraw bundle files and rejects partial responses', async () => {
    const paths = [
      '/exports/scene.excalidraw', '/exports/scene.svg', '/exports/scene@1x.png',
      '/exports/scene@2x.png', '/exports/scene@3x.png',
    ];
    const input = {
      baseName: 'scene', source: '{}', svgBase64: 'PHN2Zy8+',
      png1xBase64: 'MQ==', png2xBase64: 'Mg==', png3xBase64: 'Mw==',
    };
    invokeMock.mockResolvedValueOnce(paths);
    await expect(saveExcalidrawBundle(input)).resolves.toEqual(paths);
    expect(invokeMock).toHaveBeenCalledWith('save_excalidraw_bundle_dialog', { input });

    invokeMock.mockResolvedValueOnce(paths.slice(0, 4));
    await expect(saveExcalidrawBundle(input)).rejects.toThrow('Invalid Excalidraw bundle response');
  });

});
